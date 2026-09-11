//! Detection and bounded resizing for embedded model image inputs.

use std::io::Cursor;

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageFormat};
use serde_json::{Map, Value};

use crate::error::ProxyError;

const MAX_IMAGE_EDGE: u32 = 1_568;
const MAX_IMAGE_PIXELS: u64 = 1_150_000;
const MAX_IMAGE_INPUT_BYTES: usize = 2_000_000;

#[derive(Debug, Default, Eq, PartialEq)]
pub(crate) struct ImageNormalization {
    pub(crate) detected: usize,
    pub(crate) resized: usize,
    pub(crate) input_bytes: usize,
    pub(crate) output_bytes: usize,
}

struct EncodedImage {
    bytes: Vec<u8>,
    format: ImageFormat,
    input_bytes: usize,
    resized: bool,
}

/// Resize recognized base64 image inputs without fetching remote URLs.
pub(crate) fn normalize_embedded_images(
    input: &mut Value,
) -> Result<ImageNormalization, ProxyError> {
    let mut normalization = ImageNormalization::default();
    visit(input, &mut normalization)?;
    if normalization.detected > 0 {
        tracing::debug!(
            detected = normalization.detected,
            resized = normalization.resized,
            input_bytes = normalization.input_bytes,
            output_bytes = normalization.output_bytes,
            "embedded image inputs normalized"
        );
    }
    Ok(normalization)
}

fn visit(value: &mut Value, normalization: &mut ImageNormalization) -> Result<(), ProxyError> {
    match value {
        Value::String(value) => normalize_data_url(value, normalization),
        Value::Array(values) => {
            for value in values {
                visit(value, normalization)?;
            }
            Ok(())
        }
        Value::Object(value) => {
            normalize_base64_source(value, normalization)?;
            for value in value.values_mut() {
                visit(value, normalization)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn normalize_data_url(
    value: &mut String,
    normalization: &mut ImageNormalization,
) -> Result<(), ProxyError> {
    let Some(data) = value.strip_prefix("data:") else {
        return Ok(());
    };
    let Some((metadata, encoded)) = data.split_once(',') else {
        return Ok(());
    };
    if !metadata
        .split(';')
        .any(|parameter| parameter.eq_ignore_ascii_case("base64"))
    {
        return Ok(());
    }
    let declared_image = metadata
        .split(';')
        .next()
        .is_some_and(|media_type| media_type.starts_with("image/"));
    let Some(image) = decode_image(encoded, declared_image)? else {
        return Ok(());
    };
    record_image(normalization, &image);
    if image.resized {
        *value = format!(
            "data:{};base64,{}",
            media_type(image.format),
            STANDARD.encode(image.bytes)
        );
    } else if metadata.split(';').next() != Some(media_type(image.format)) {
        *value = format!("data:{};base64,{encoded}", media_type(image.format));
    }
    Ok(())
}

fn normalize_base64_source(
    value: &mut Map<String, Value>,
    normalization: &mut ImageNormalization,
) -> Result<(), ProxyError> {
    if value.get("type").and_then(Value::as_str) != Some("base64") {
        return Ok(());
    }
    let declared_image = value
        .get("media_type")
        .and_then(Value::as_str)
        .is_some_and(|media_type| media_type.starts_with("image/"));
    let Some(encoded) = value.get("data").and_then(Value::as_str) else {
        return Ok(());
    };
    let Some(image) = decode_image(encoded, declared_image)? else {
        return Ok(());
    };
    record_image(normalization, &image);
    value.insert(
        "media_type".to_owned(),
        Value::String(media_type(image.format).to_owned()),
    );
    if image.resized {
        value.insert(
            "data".to_owned(),
            Value::String(STANDARD.encode(image.bytes)),
        );
    }
    Ok(())
}

fn decode_image(encoded: &str, declared_image: bool) -> Result<Option<EncodedImage>, ProxyError> {
    let compact = encoded
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    let bytes = match STANDARD.decode(compact) {
        Ok(bytes) => bytes,
        Err(error) if declared_image => {
            return Err(ProxyError::Image(format!("invalid base64 image: {error}")));
        }
        Err(_) => return Ok(None),
    };
    let format = match image::guess_format(&bytes) {
        Ok(ImageFormat::Jpeg) => ImageFormat::Jpeg,
        Ok(ImageFormat::Png) => ImageFormat::Png,
        Ok(ImageFormat::WebP) => ImageFormat::WebP,
        Ok(_) | Err(_) => return Ok(None),
    };
    let decoded = image::load_from_memory_with_format(&bytes, format)
        .map_err(|error| ProxyError::Image(format!("invalid embedded image: {error}")))?;
    let input_bytes = bytes.len();
    if input_bytes <= MAX_IMAGE_INPUT_BYTES {
        return Ok(Some(EncodedImage {
            bytes,
            format,
            input_bytes,
            resized: false,
        }));
    }
    let (width, height) = target_dimensions(decoded.width(), decoded.height())
        .unwrap_or_else(|| decoded.dimensions());
    let resized = if (width, height) == decoded.dimensions() {
        decoded
    } else {
        decoded.resize_exact(width, height, FilterType::Triangle)
    };
    let bytes = encode_image(&resized, format)?;
    Ok(Some(EncodedImage {
        bytes,
        format,
        input_bytes,
        resized: true,
    }))
}

fn target_dimensions(width: u32, height: u32) -> Option<(u32, u32)> {
    let edge_scale = f64::from(MAX_IMAGE_EDGE) / f64::from(width.max(height));
    let pixel_scale =
        (MAX_IMAGE_PIXELS as f64 / (u64::from(width) * u64::from(height)) as f64).sqrt();
    let scale = edge_scale.min(pixel_scale).min(1.0);
    if scale >= 1.0 {
        return None;
    }
    let mut target_width = (f64::from(width) * scale).round().max(1.0) as u32;
    let mut target_height = (f64::from(height) * scale).round().max(1.0) as u32;
    while u64::from(target_width) * u64::from(target_height) > MAX_IMAGE_PIXELS {
        if target_width >= target_height {
            target_width -= 1;
        } else {
            target_height -= 1;
        }
    }
    Some((target_width, target_height))
}

fn encode_image(image: &DynamicImage, format: ImageFormat) -> Result<Vec<u8>, ProxyError> {
    let mut output = Cursor::new(Vec::new());
    if format == ImageFormat::Jpeg {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 90)
            .encode_image(image)
            .map_err(|error| ProxyError::Image(format!("image resize failed: {error}")))?;
    } else {
        image
            .write_to(&mut output, format)
            .map_err(|error| ProxyError::Image(format!("image resize failed: {error}")))?;
    }
    Ok(output.into_inner())
}

fn media_type(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png => "image/png",
        ImageFormat::WebP => "image/webp",
        _ => unreachable!("unsupported image format"),
    }
}

fn record_image(normalization: &mut ImageNormalization, image: &EncodedImage) {
    normalization.detected += 1;
    normalization.input_bytes += image.input_bytes;
    if image.resized {
        normalization.resized += 1;
        normalization.output_bytes += image.bytes.len();
    } else {
        normalization.output_bytes += image.input_bytes;
    }
}

#[cfg(test)]
mod tests {
    use image::{GenericImageView, Rgb, RgbImage};
    use serde_json::json;

    use super::*;

    fn encode_png(image: RgbImage) -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(image);
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, ImageFormat::Png).unwrap();
        output.into_inner()
    }

    fn noisy_png(width: u32, height: u32) -> Vec<u8> {
        encode_png(RgbImage::from_fn(width, height, |x, y| {
            let mut value = u64::from(y) * u64::from(width) + u64::from(x);
            value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            value ^= value >> 31;
            Rgb([value as u8, (value >> 8) as u8, (value >> 16) as u8])
        }))
    }

    fn solid_png(width: u32, height: u32) -> Vec<u8> {
        encode_png(RgbImage::new(width, height))
    }

    fn data_url(bytes: &[u8]) -> String {
        format!("data:image/png;base64,{}", STANDARD.encode(bytes))
    }

    #[test]
    fn resizes_large_data_url_images_for_model_input() {
        let image = noisy_png(3_000, 1_000);
        assert!(image.len() > MAX_IMAGE_INPUT_BYTES);
        let mut input = json!({
            "messages": [{
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": data_url(&image)}}]
            }]
        });
        let result = normalize_embedded_images(&mut input).unwrap();
        let encoded = input["messages"][0]["content"][0]["image_url"]["url"]
            .as_str()
            .unwrap()
            .split_once(',')
            .unwrap()
            .1;
        let resized = image::load_from_memory(&STANDARD.decode(encoded).unwrap()).unwrap();

        assert_eq!(result.detected, 1);
        assert_eq!(result.resized, 1);
        assert_eq!(resized.dimensions(), (1_568, 523));
    }

    #[test]
    fn caps_square_images_by_total_pixels() {
        let image = noisy_png(2_000, 2_000);
        assert!(image.len() > MAX_IMAGE_INPUT_BYTES);
        let mut input = json!({
            "type": "base64",
            "media_type": "application/octet-stream",
            "data": STANDARD.encode(image)
        });
        let result = normalize_embedded_images(&mut input).unwrap();
        let resized =
            image::load_from_memory(&STANDARD.decode(input["data"].as_str().unwrap()).unwrap())
                .unwrap();

        assert_eq!(result.resized, 1);
        assert!(u64::from(resized.width()) * u64::from(resized.height()) <= MAX_IMAGE_PIXELS);
        assert_eq!(input["media_type"], "image/png");
    }

    #[test]
    fn preserves_small_images_and_remote_urls() {
        let original = data_url(&solid_png(64, 32));
        let mut input = json!({
            "local": original,
            "remote": "https://example.com/image.png"
        });
        let result = normalize_embedded_images(&mut input).unwrap();

        assert_eq!(result.detected, 1);
        assert_eq!(result.resized, 0);
        assert_eq!(input["local"], original);
        assert_eq!(input["remote"], "https://example.com/image.png");
    }

    #[test]
    fn preserves_compressed_images_below_two_mb_regardless_of_resolution() {
        let image = solid_png(3_000, 1_000);
        assert!(image.len() <= MAX_IMAGE_INPUT_BYTES);
        let original = data_url(&image);
        let mut input = json!({"image_url": original});

        let result = normalize_embedded_images(&mut input).unwrap();

        assert_eq!(result.detected, 1);
        assert_eq!(result.resized, 0);
        assert_eq!(input["image_url"], original);
    }
}
