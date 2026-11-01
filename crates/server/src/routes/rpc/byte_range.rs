//! Single byte-range requests (RFC 9110 §14) for the binary file endpoints.
//!
//! Media elements fetch with `Range` to seek: without a `206 Partial Content`
//! answer, Chromium-based webviews treat the stream as unseekable, so audio and
//! video can only play from the start. Only a single range is honoured; any
//! form this module does not serve falls back to the full body, which the RFC
//! permits a server to do for a `Range` it chooses to ignore.

use axum::http::{header, HeaderMap};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ByteRange {
    /// Serve the whole representation with `200 OK`.
    Full,
    /// Serve the inclusive byte span `start..=end` with `206 Partial Content`.
    Partial { start: u64, end: u64 },
    /// No requested byte exists: `416 Range Not Satisfiable`.
    Unsatisfiable,
}

impl ByteRange {
    /// The span the request asks for out of a representation of `size` bytes.
    pub(crate) fn requested(headers: &HeaderMap, size: u64) -> Self {
        // These responses carry no validators, so an `If-Range` can never
        // match and the full representation must be sent (RFC 9110 §13.1.5).
        if headers.contains_key(header::IF_RANGE) {
            return Self::Full;
        }
        match headers.get(header::RANGE).map(|value| value.to_str()) {
            Some(Ok(value)) => Self::parse(value, size),
            _ => Self::Full,
        }
    }

    fn parse(value: &str, size: u64) -> Self {
        let Some(spec) = value.trim().strip_prefix("bytes=") else {
            return Self::Full;
        };
        if spec.contains(',') {
            return Self::Full;
        }
        let Some((first, last)) = spec.trim().split_once('-') else {
            return Self::Full;
        };
        let (first, last) = (first.trim(), last.trim());
        let parse = |digits: &str| {
            (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
                .then(|| digits.parse::<u64>().ok())
                .flatten()
        };

        if first.is_empty() {
            // Suffix form `-N`: the last N bytes.
            return match parse(last) {
                Some(0) => Self::Unsatisfiable,
                Some(_) if size == 0 => Self::Unsatisfiable,
                Some(length) => Self::Partial {
                    start: size.saturating_sub(length),
                    end: size - 1,
                },
                None => Self::Full,
            };
        }

        let Some(start) = parse(first) else {
            return Self::Full;
        };
        let end = if last.is_empty() {
            None
        } else {
            match parse(last) {
                Some(end) if end >= start => Some(end),
                _ => return Self::Full,
            }
        };
        if start >= size {
            return Self::Unsatisfiable;
        }
        Self::Partial {
            start,
            end: end.map_or(size - 1, |end| end.min(size - 1)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn range(value: &str, size: u64) -> ByteRange {
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_str(value).unwrap());
        ByteRange::requested(&headers, size)
    }

    fn partial(start: u64, end: u64) -> ByteRange {
        ByteRange::Partial { start, end }
    }

    #[test]
    fn no_range_header_serves_the_full_body() {
        assert_eq!(
            ByteRange::requested(&HeaderMap::new(), 100),
            ByteRange::Full
        );
    }

    #[test]
    fn closed_range_is_served_inclusively() {
        assert_eq!(range("bytes=0-1", 100), partial(0, 1));
        assert_eq!(range("bytes=10-19", 100), partial(10, 19));
    }

    #[test]
    fn closed_range_past_the_end_is_clamped() {
        assert_eq!(range("bytes=90-500", 100), partial(90, 99));
    }

    #[test]
    fn open_range_runs_to_the_end() {
        assert_eq!(range("bytes=40-", 100), partial(40, 99));
    }

    #[test]
    fn suffix_range_takes_the_tail() {
        assert_eq!(range("bytes=-10", 100), partial(90, 99));
        assert_eq!(range("bytes=-500", 100), partial(0, 99));
    }

    #[test]
    fn range_starting_beyond_the_body_is_unsatisfiable() {
        assert_eq!(range("bytes=100-", 100), ByteRange::Unsatisfiable);
        assert_eq!(range("bytes=150-200", 100), ByteRange::Unsatisfiable);
        assert_eq!(range("bytes=-0", 100), ByteRange::Unsatisfiable);
        assert_eq!(range("bytes=0-", 0), ByteRange::Unsatisfiable);
        assert_eq!(range("bytes=-5", 0), ByteRange::Unsatisfiable);
    }

    #[test]
    fn malformed_or_unsupported_ranges_serve_the_full_body() {
        for value in [
            "items=0-1",
            "bytes=",
            "bytes=-",
            "bytes=5",
            "bytes=9-3",
            "bytes=a-b",
            "bytes=+1-2",
            "bytes=0-1,5-6",
        ] {
            assert_eq!(range(value, 100), ByteRange::Full, "{value}");
        }
    }

    #[test]
    fn if_range_without_validators_serves_the_full_body() {
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=0-1"));
        headers.insert(header::IF_RANGE, HeaderValue::from_static("\"etag\""));
        assert_eq!(ByteRange::requested(&headers, 100), ByteRange::Full);
    }
}
