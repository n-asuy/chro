//! Bounding the command output a conversation entry carries.
//!
//! An entry's output is for reading in a scroll box, not for archiving: the
//! full output stays in the run log and in the agent's own context. Carrying it
//! all made one 65 MB command output a single entry that every patch, replay,
//! and the client had to hold, and made each streamed chunk re-send it whole.
//! Entries therefore keep only the tail, where results and errors land.

use crate::{CommandExitStatus, CommandRunResult};

/// Most bytes of output a command entry carries.
pub const COMMAND_OUTPUT_LIMIT: usize = 64 * 1024;

/// First line of output whose head was dropped.
pub const TRUNCATED_OUTPUT_MARKER: &str = "[chro] earlier output truncated";

impl CommandRunResult {
    /// The only constructor executors use, so every entry is bounded.
    pub fn new(exit_status: Option<CommandExitStatus>, output: Option<String>) -> Self {
        Self {
            exit_status,
            output: output.map(bound_command_output),
        }
    }
}

/// Keep the last [`COMMAND_OUTPUT_LIMIT`] bytes of `output`, marking the cut.
pub fn bound_command_output(output: String) -> String {
    if output.len() <= COMMAND_OUTPUT_LIMIT {
        return output;
    }
    let tail = &output[tail_start(&output, COMMAND_OUTPUT_LIMIT)..];
    format!("{TRUNCATED_OUTPUT_MARKER}\n{tail}")
}

/// Accumulates streamed output, retaining at least the tail an entry can
/// carry and at most twice that, so trimming is amortized `O(1)` per byte.
/// The bound itself is applied once, by [`CommandRunResult::new`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OutputTail {
    text: String,
}

impl OutputTail {
    pub fn push_str(&mut self, chunk: &str) {
        self.text.push_str(chunk);
        if self.text.len() > 2 * COMMAND_OUTPUT_LIMIT {
            let start = tail_start(&self.text, COMMAND_OUTPUT_LIMIT);
            self.text.drain(..start);
        }
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }
}

/// Byte offset where the last `keep` bytes of `text` begin, moved forward to a
/// char boundary so the tail is valid UTF-8.
fn tail_start(text: &str, keep: usize) -> usize {
    let mut start = text.len().saturating_sub(keep);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    start
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_output_is_untouched() {
        assert_eq!(bound_command_output("ok\n".into()), "ok\n");
    }

    #[test]
    fn long_output_keeps_a_marked_tail() {
        let output = "a".repeat(COMMAND_OUTPUT_LIMIT) + "tail";

        let bounded = bound_command_output(output);

        assert!(bounded.starts_with(TRUNCATED_OUTPUT_MARKER));
        assert!(bounded.ends_with("tail"));
        assert!(bounded.len() <= COMMAND_OUTPUT_LIMIT + TRUNCATED_OUTPUT_MARKER.len() + 1);
    }

    #[test]
    fn cut_lands_on_a_char_boundary() {
        // 3-byte chars: the naive cut point falls inside one.
        let output = "あ".repeat(COMMAND_OUTPUT_LIMIT / 3 + 2);

        let bounded = bound_command_output(output);

        assert!(bounded.ends_with('あ'));
    }

    #[test]
    fn result_constructor_bounds_output() {
        let result = CommandRunResult::new(None, Some("x".repeat(COMMAND_OUTPUT_LIMIT * 3)));

        assert!(result.output.unwrap().len() < COMMAND_OUTPUT_LIMIT * 2);
    }

    #[test]
    fn tail_buffer_stays_bounded_and_keeps_the_end() {
        let mut tail = OutputTail::default();
        for chunk in 0..100_000 {
            tail.push_str(&format!("line {chunk}\n"));
        }

        assert!(tail.as_str().len() <= 2 * COMMAND_OUTPUT_LIMIT);
        assert!(tail.as_str().len() >= COMMAND_OUTPUT_LIMIT);
        assert!(tail.as_str().ends_with("line 99999\n"));
    }
}
