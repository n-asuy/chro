//! Binary payloads (image uploads and file or image downloads) inside
//! encrypted binary frames.
//!
//! Each frame's plaintext is
//!
//! ```text
//! version(1) = 0x01 ‖ u32be(header_len) ‖ header (UTF-8 JSON) ‖ body chunk
//! ```
//!
//! A payload larger than one chunk is split across frames that share an
//! `id` and number their chunks from `seq: 0`; the last has `final: true`.
//! The first chunk's header carries the envelope, later ones only
//! `{id, seq, final}`. Chunks stay under the listener's 1 MiB message limit.

use serde_json::{json, Map, Value};

pub(crate) const BINARY_FRAME_VERSION: u8 = 1;
/// Largest body chunk per frame.
pub(crate) const CHUNK_BYTES: usize = 768 * 1024;
const PREFIX_BYTES: usize = 1 + 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BinaryFrameError(pub String);

/// Build one frame's plaintext.
pub(crate) fn encode(header: &Value, body: &[u8]) -> Vec<u8> {
    let header = serde_json::to_vec(header).expect("headers always serialize");
    let mut out = Vec::with_capacity(PREFIX_BYTES + header.len() + body.len());
    out.push(BINARY_FRAME_VERSION);
    out.extend_from_slice(&(header.len() as u32).to_be_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(body);
    out
}

/// Split one frame's plaintext into its header object and body chunk.
pub(crate) fn decode(payload: &[u8]) -> Result<(Map<String, Value>, &[u8]), BinaryFrameError> {
    if payload.len() < PREFIX_BYTES {
        return Err(BinaryFrameError(
            "binary frame is shorter than its prefix".into(),
        ));
    }
    if payload[0] != BINARY_FRAME_VERSION {
        return Err(BinaryFrameError(format!(
            "unknown binary frame version {}",
            payload[0]
        )));
    }
    let header_len = u32::from_be_bytes(payload[1..5].try_into().unwrap()) as usize;
    let header_end = PREFIX_BYTES
        .checked_add(header_len)
        .filter(|end| *end <= payload.len())
        .ok_or_else(|| BinaryFrameError("binary frame header overruns the frame".into()))?;
    let header: Value = serde_json::from_slice(&payload[PREFIX_BYTES..header_end])
        .map_err(|err| BinaryFrameError(format!("binary frame header is not JSON: {err}")))?;
    let Value::Object(header) = header else {
        return Err(BinaryFrameError(
            "binary frame header is not an object".into(),
        ));
    };
    Ok((header, &payload[header_end..]))
}

/// The frames of one binary reply: `first` is the first chunk's header
/// (without `id`, `seq` and `final`, which are filled in).
pub(crate) fn reply_frames(id: &str, first: Map<String, Value>, body: &[u8]) -> Vec<Vec<u8>> {
    let chunks: Vec<&[u8]> = if body.is_empty() {
        vec![&[]]
    } else {
        body.chunks(CHUNK_BYTES).collect()
    };
    let last = chunks.len() - 1;
    chunks
        .into_iter()
        .enumerate()
        .map(|(seq, chunk)| {
            let mut header = if seq == 0 { first.clone() } else { Map::new() };
            header.insert("id".into(), json!(id));
            header.insert("seq".into(), json!(seq));
            header.insert("final".into(), json!(seq == last));
            encode(&Value::Object(header), chunk)
        })
        .collect()
}

/// One chunk's position in its payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChunkPosition {
    pub id: String,
    pub seq: u64,
    pub is_final: bool,
}

pub(crate) fn position(header: &Map<String, Value>) -> Result<ChunkPosition, BinaryFrameError> {
    let id = header
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| BinaryFrameError("binary frame header needs a non-empty id".into()))?;
    let seq = header
        .get("seq")
        .and_then(Value::as_u64)
        .ok_or_else(|| BinaryFrameError("binary frame header needs seq".into()))?;
    let is_final = header
        .get("final")
        .and_then(Value::as_bool)
        .ok_or_else(|| BinaryFrameError("binary frame header needs final".into()))?;
    Ok(ChunkPosition {
        id: id.to_string(),
        seq,
        is_final,
    })
}

/// Collects one chunked upload.
#[derive(Debug)]
pub(crate) struct Assembly {
    /// The first chunk's header.
    pub header: Map<String, Value>,
    pub body: Vec<u8>,
    next_seq: u64,
    limit: usize,
}

impl Assembly {
    pub(crate) fn start(
        header: Map<String, Value>,
        chunk: &[u8],
        limit: usize,
    ) -> Result<Self, BinaryFrameError> {
        let mut assembly = Self {
            header,
            body: Vec::new(),
            next_seq: 1,
            limit,
        };
        assembly.extend(chunk)?;
        Ok(assembly)
    }

    /// Append chunk `seq`.
    pub(crate) fn push(&mut self, seq: u64, chunk: &[u8]) -> Result<(), BinaryFrameError> {
        if seq != self.next_seq {
            return Err(BinaryFrameError(format!(
                "expected chunk {}, got {seq}",
                self.next_seq
            )));
        }
        self.next_seq += 1;
        self.extend(chunk)
    }

    fn extend(&mut self, chunk: &[u8]) -> Result<(), BinaryFrameError> {
        if self.body.len() + chunk.len() > self.limit {
            return Err(BinaryFrameError(format!(
                "upload exceeds {} bytes",
                self.limit
            )));
        }
        self.body.extend_from_slice(chunk);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let header = json!({"id": "1", "seq": 0, "final": true});
        let frame = encode(&header, b"body");
        assert_eq!(frame[0], BINARY_FRAME_VERSION);
        let (decoded, body) = decode(&frame).unwrap();
        assert_eq!(Value::Object(decoded), header);
        assert_eq!(body, b"body");
    }

    #[test]
    fn malformed_frames_are_refused() {
        assert!(decode(&[]).is_err());
        assert!(decode(&[2, 0, 0, 0, 0]).is_err(), "unknown version");
        assert!(
            decode(&[1, 0, 0, 0, 9, b'{', b'}']).is_err(),
            "header overrun"
        );
        assert!(decode(&encode(&json!([1]), b"")).is_err(), "array header");
        let mut not_json = vec![1, 0, 0, 0, 1];
        not_json.push(b'x');
        assert!(decode(&not_json).is_err());
    }

    #[test]
    fn large_replies_are_chunked_with_the_envelope_on_the_first() {
        let body = vec![7u8; CHUNK_BYTES * 2 + 10];
        let mut first = Map::new();
        first.insert("ok".into(), json!(true));
        let frames = reply_frames("r", first, &body);
        assert_eq!(frames.len(), 3);

        let mut collected = Vec::new();
        for (index, frame) in frames.iter().enumerate() {
            let (header, chunk) = decode(frame).unwrap();
            let pos = position(&header).unwrap();
            assert_eq!(pos.id, "r");
            assert_eq!(pos.seq, index as u64);
            assert_eq!(pos.is_final, index == 2);
            assert_eq!(header.contains_key("ok"), index == 0);
            assert!(frame.len() < 1024 * 1024);
            collected.extend_from_slice(chunk);
        }
        assert_eq!(collected, body);
    }

    #[test]
    fn an_empty_body_is_one_final_frame() {
        let frames = reply_frames("r", Map::new(), &[]);
        assert_eq!(frames.len(), 1);
        let (header, chunk) = decode(&frames[0]).unwrap();
        assert!(position(&header).unwrap().is_final);
        assert!(chunk.is_empty());
    }

    #[test]
    fn assemblies_take_chunks_in_order_up_to_the_limit() {
        let mut skipped = Assembly::start(Map::new(), b"ab", 5).unwrap();
        assert!(skipped.push(2, b"c").is_err(), "skipped chunk 1");

        let mut assembly = Assembly::start(Map::new(), b"ab", 5).unwrap();
        assembly.push(1, b"cd").unwrap();
        assert_eq!(assembly.body, b"abcd");
        assert!(assembly.push(2, b"ef").is_err(), "over the limit");
        assert!(Assembly::start(Map::new(), b"abcdef", 5).is_err());
    }
}
