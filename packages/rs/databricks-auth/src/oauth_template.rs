use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};

const BRAND_YAML: &str = include_str!("../assets/brand.yaml");
const DEFAULT_CALLBACK_IMAGE: &[u8] = include_bytes!("../assets/logo-light.svg");

/// Build the default callback logo as an embedded SVG data URI.
pub fn default_callback_image_src() -> String {
    format!(
        "data:image/svg+xml;base64,{}",
        BASE64_STANDARD.encode(DEFAULT_CALLBACK_IMAGE),
    )
}

/// Branding and content renderer for the browser OAuth callback.
#[derive(Clone, Debug)]
pub struct OAuthTemplate {
    brand: CallbackBrand,
    image_src: String,
}

#[derive(Clone, Debug)]
struct CallbackBrand {
    name: &'static str,
    tagline: &'static str,
    primary: &'static str,
    primary_hover: &'static str,
    foreground: &'static str,
    background: &'static str,
    surface: &'static str,
    muted: &'static str,
    border: &'static str,
    font_family: &'static str,
}

/// Values displayed by the browser OAuth callback.
pub struct OAuthTemplateContext<'a> {
    /// Databricks host linked from a successful callback.
    pub host: Option<&'a str>,
    /// OAuth error identifier displayed by an unsuccessful callback.
    pub error: Option<&'a str>,
    /// OAuth error detail displayed by an unsuccessful callback.
    pub error_description: Option<&'a str>,
}

impl OAuthTemplate {
    /// Create a callback renderer with an optional logo URL or data URI.
    pub fn new(image_src: Option<String>) -> Self {
        Self {
            brand: CallbackBrand::load(),
            image_src: image_src.unwrap_or_else(default_callback_image_src),
        }
    }

    /// Build the complete callback HTML with escaped dynamic values.
    pub fn render(&self, context: OAuthTemplateContext<'_>) -> String {
        let page_title = context
            .error
            .map(title)
            .unwrap_or_else(|| "Success".to_owned());
        let result = if context.error.is_some() {
            format!(
                r#"<div class="title">{}</div><div class="content">{}</div>"#,
                escape_html(&page_title),
                escape_html(context.error_description.unwrap_or_default()),
            )
        } else {
            let host = context.host.map_or_else(String::new, |host| {
                let host = escape_html(host);
                format!(r#"<div class="content">Go to <a href="{host}">{host}</a></div>"#)
            });
            format!(r#"<div class="title">Authenticated</div>{host}"#)
        };
        let image_src = escape_html(&self.image_src);
        let page_title = escape_html(&page_title);
        let brand_name = escape_html(self.brand.name);
        let tagline = escape_html(self.brand.tagline);
        let primary = self.brand.primary;
        let primary_hover = self.brand.primary_hover;
        let foreground = self.brand.foreground;
        let background = self.brand.background;
        let surface = self.brand.surface;
        let muted = self.brand.muted;
        let border = self.brand.border;
        let font_family = self.brand.font_family;

        format!(
            r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{page_title}</title>
    <style>
      html, body {{ height: 100%; }}
      body {{
        margin: 0;
        background: {surface};
        color: {foreground};
        font-family: {font_family};
      }}
      .root-container {{
        display: flex;
        min-height: 100%;
        align-items: center;
        justify-content: center;
      }}
      .info-container {{
        display: flex;
        width: min(320px, calc(100vw - 96px));
        flex-direction: column;
        align-items: center;
        gap: 24px;
        padding: 48px;
        border: 1px solid {border};
        border-radius: 12px;
        background: {background};
        box-shadow: 0 8px 25px rgba(27, 49, 57, 0.12);
        text-align: center;
      }}
      .brand {{ display: block; width: 360px; max-width: calc(100vw - 96px); height: auto; margin: 0 auto; transform: translateX(8%); }}
      .tagline {{ color: {muted}; font-size: 13px; line-height: 18px; }}
      .title {{ color: {primary}; font-size: 24px; font-weight: 700; line-height: 28px; }}
      .content {{ width: 100%; color: {muted}; font-size: 14px; line-height: 20px; }}
      a {{ color: {primary}; }}
      a:hover {{ color: {primary_hover}; }}
    </style>
  </head>
  <body>
    <main class="root-container">
      <section class="info-container">
        <img class="brand" src="{image_src}" alt="{brand_name}">
        <div class="tagline">{tagline}</div>
        {result}
        <div class="content">You can close this tab.</div>
      </section>
    </main>
  </body>
</html>"#
        )
    }
}

impl Default for OAuthTemplate {
    fn default() -> Self {
        Self::new(None)
    }
}

impl CallbackBrand {
    fn load() -> Self {
        Self {
            name: brand_value("name").unwrap_or("dbx tools"),
            tagline: brand_value("tagline").unwrap_or("Practical tools for Databricks builders."),
            primary: brand_value("primary").unwrap_or("#1B3139"),
            primary_hover: brand_value("primaryHover").unwrap_or("#0E538B"),
            foreground: brand_value("foreground").unwrap_or("#1B3139"),
            background: brand_value("background").unwrap_or("#FFFFFF"),
            surface: brand_value("surface").unwrap_or("#F9F7F4"),
            muted: brand_value("muted").unwrap_or("#618794"),
            border: brand_value("border").unwrap_or("#E4E2DD"),
            font_family: brand_value("sans")
                .unwrap_or("'DM Sans', ui-sans-serif, system-ui, sans-serif"),
        }
    }
}

fn brand_value(key: &str) -> Option<&'static str> {
    BRAND_YAML.lines().find_map(|line| {
        let (candidate, value) = line.trim().split_once(':')?;
        if candidate != key {
            return None;
        }
        let value = value
            .split_once(" #")
            .map_or(value, |(value, _)| value)
            .trim()
            .trim_matches('"');
        (!value.is_empty()).then_some(value)
    })
}

fn title(value: &str) -> String {
    value
        .split(['_', ' '])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut characters = word.chars();
            match characters.next() {
                Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#x27;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::{brand_value, default_callback_image_src, OAuthTemplate, OAuthTemplateContext};

    #[test]
    fn renders_default_branding_and_success() {
        let html = OAuthTemplate::default().render(OAuthTemplateContext {
            host: Some("https://example.com/?a=1&b=2"),
            error: None,
            error_description: None,
        });

        assert!(html.contains(&default_callback_image_src()));
        assert!(default_callback_image_src().starts_with("data:image/svg+xml;base64,"));
        assert_eq!(brand_value("primary"), Some("#1B3139"));
        assert!(html.contains("Practical tools for Databricks builders."));
        assert!(html.contains("Authenticated"));
        assert!(html.contains("https://example.com/?a=1&amp;b=2"));
    }

    #[test]
    fn renders_custom_branding_and_escaped_error() {
        let html = OAuthTemplate::new(Some("data:image/svg+xml,&custom".to_owned())).render(
            OAuthTemplateContext {
                host: None,
                error: Some("access_denied"),
                error_description: Some("<denied>"),
            },
        );

        assert!(html.contains(r#"src="data:image/svg+xml,&amp;custom""#));
        assert!(html.contains("Access Denied"));
        assert!(html.contains("&lt;denied&gt;"));
        assert!(!html.contains("Authenticated"));
    }
}
