from typing import Any, Mapping
from urllib.parse import ParseResult, urlparse

_URL_PARSE_DEFAULT = {"scheme": "https"}


def url_parse(
    input: Any,
    default: Mapping[str, Any] | None = _URL_PARSE_DEFAULT,
    replace: Mapping[str, Any] | None = None,
) -> ParseResult | None:
    if isinstance(input, ParseResult):
        return input
    elif input is not None and (input_str := str(input).strip()):
        if "://" not in input_str:
            input_str = "//" + input_str
        try:
            url_result = urlparse(input_str)
        except Exception:
            url_result = None
        if url_result and url_result.hostname:
            url_result_replace: dict[str, Any] | None = None
            if default:
                for key, default_value in default.items():
                    value = getattr(url_result, key, None)
                    if value is None or value == "":
                        if url_result_replace is None:
                            url_result_replace = {}
                        url_result_replace[key] = default_value
            if replace:
                if url_result_replace is None:
                    url_result_replace = {}
                url_result_replace.update(replace)
            if url_result_replace:
                url_result = url_result._replace(**url_result_replace)
            return url_result
    return None


def hostname_parse(input: Any) -> str | None:
    if url_result := url_parse(input):
        return url_result.hostname
    return None


def scheme_hostname_parse(
    input: Any,
    default: Mapping[str, Any] | None = _URL_PARSE_DEFAULT,
    replace: Mapping[str, Any] | None = None,
) -> tuple[str, str] | None:
    if url_result := url_parse(input, default, replace):
        if url_result.scheme and url_result.hostname:
            return url_result.scheme, url_result.hostname
    return None
