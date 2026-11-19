//! The Option key gestures of the edge toolbar, the mock's keyboard model:
//!
//! - Option pressed twice quickly, alone: summon.
//! - Option held: press to talk; releasing it sends.
//! - Option tapped while listening: send.
//!
//! Fed by the edge window's cursor poll with samples of the global modifier
//! state and the session's key-down counter (neither needs a privacy
//! permission). A press is "clean" while no other key or modifier goes down
//! with it. A clean press released within [`HOLD_MS`] is a tap; two taps whose
//! releases are within [`DOUBLE_TAP_MS`] summon. A clean press still down
//! after [`HOLD_MS`] starts talking (unless already listening), and its
//! release sends. Any other key or modifier between two taps breaks the pair.

/// Longest press that still counts as a tap, and how long a press is held
/// before it starts talking.
pub const HOLD_MS: u64 = 300;

/// Longest time between the two taps' releases.
pub const DOUBLE_TAP_MS: u64 = 350;

/// One sample of the keyboard state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyState {
    /// Option is down.
    pub option: bool,
    /// Shift, Control or Command is down.
    pub other_modifier: bool,
    /// Key-down events in the session so far (any key).
    pub key_downs: u64,
}

/// What a sample completed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OptionGesture {
    /// Two quick taps.
    Summon,
    /// A press held long enough: start listening.
    HoldStart,
    /// The held press was released: send what was heard.
    HoldEnd,
    /// A tap while listening: send what was heard.
    Send,
}

#[derive(Debug, Default)]
pub struct OptionGestures {
    /// When Option went down, while it is down.
    down_at: Option<u64>,
    /// Nothing else was pressed while Option has been down.
    clean: bool,
    /// This press started talking.
    holding: bool,
    /// The key-down count when Option went down or the last press ended.
    key_downs: u64,
    /// When the last tap ended, while a second one can still follow.
    last_tap: Option<u64>,
}

impl OptionGestures {
    /// Feed a sample taken at `now_ms`, with whether the toolbar is listening.
    pub fn sample(&mut self, now_ms: u64, state: KeyState, listening: bool) -> Option<OptionGesture> {
        match (self.down_at, state.option) {
            (None, true) => {
                // A key pressed since the last tap breaks the pair.
                if state.key_downs != self.key_downs || state.other_modifier {
                    self.last_tap = None;
                }
                self.down_at = Some(now_ms);
                self.clean = !state.other_modifier;
                self.holding = false;
                self.key_downs = state.key_downs;
                None
            }
            (Some(down_at), true) => {
                if state.other_modifier || state.key_downs != self.key_downs {
                    self.clean = false;
                }
                let held = now_ms.saturating_sub(down_at) >= HOLD_MS;
                if held && self.clean && !self.holding && !listening {
                    self.holding = true;
                    self.last_tap = None;
                    return Some(OptionGesture::HoldStart);
                }
                None
            }
            (Some(down_at), false) => {
                self.down_at = None;
                let clean = self.clean && state.key_downs == self.key_downs;
                self.key_downs = state.key_downs;
                if std::mem::take(&mut self.holding) {
                    return Some(OptionGesture::HoldEnd);
                }
                if !clean || now_ms.saturating_sub(down_at) > HOLD_MS {
                    self.last_tap = None;
                    return None;
                }
                if listening {
                    self.last_tap = None;
                    return Some(OptionGesture::Send);
                }
                match self.last_tap {
                    Some(previous) if now_ms.saturating_sub(previous) <= DOUBLE_TAP_MS => {
                        self.last_tap = None;
                        Some(OptionGesture::Summon)
                    }
                    _ => {
                        self.last_tap = Some(now_ms);
                        None
                    }
                }
            }
            (None, false) => {
                if state.other_modifier || state.key_downs != self.key_downs {
                    self.last_tap = None;
                    self.key_downs = state.key_downs;
                }
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use OptionGesture::*;

    const fn up(keys: u64) -> KeyState {
        KeyState { option: false, other_modifier: false, key_downs: keys }
    }
    const fn down(keys: u64) -> KeyState {
        KeyState { option: true, other_modifier: false, key_downs: keys }
    }

    /// Samples every 8 ms, as the poll does, the state being the last one
    /// given at or before that time; listening follows the gestures the way
    /// the toolbar does. Returns the gestures with their times.
    fn run(samples: &[(u64, KeyState)]) -> Vec<(u64, OptionGesture)> {
        let mut gestures = OptionGestures::default();
        let mut listening = false;
        let mut out = Vec::new();
        let end = samples.last().map_or(0, |(t, _)| *t);
        for at in (0..=end).step_by(8) {
            let Some((_, state)) = samples.iter().rev().find(|(t, _)| *t <= at) else {
                continue;
            };
            if let Some(gesture) = gestures.sample(at, *state, listening) {
                listening = match gesture {
                    HoldStart => true,
                    HoldEnd | Send => false,
                    Summon => listening,
                };
                out.push((at, gesture));
            }
        }
        out
    }

    fn kinds(samples: &[(u64, KeyState)]) -> Vec<OptionGesture> {
        run(samples).into_iter().map(|(_, g)| g).collect()
    }

    #[test]
    fn two_quick_taps_summon_once() {
        assert_eq!(kinds(&[(0, up(0)), (8, down(0)), (88, up(0)), (200, down(0)), (280, up(0))]), vec![Summon]);
    }

    #[test]
    fn taps_further_apart_than_the_window_do_not() {
        assert!(kinds(&[(0, up(0)), (8, down(0)), (88, up(0)), (400, down(0)), (456, up(0))]).is_empty());
    }

    #[test]
    fn a_third_tap_starts_a_new_pair() {
        let taps = [
            (0, up(0)),
            (8, down(0)),
            (56, up(0)),
            (120, down(0)),
            (168, up(0)),
            (232, down(0)),
            (280, up(0)),
        ];
        assert_eq!(kinds(&taps), vec![Summon]);
    }

    #[test]
    fn a_key_pressed_with_option_cancels() {
        // Option+key (typing a special character), then a tap.
        let samples = [(0, up(0)), (8, down(0)), (40, down(1)), (88, up(1)), (200, down(1)), (256, up(1))];
        assert!(kinds(&samples).is_empty());
    }

    #[test]
    fn a_key_pressed_between_the_taps_cancels() {
        let samples = [(0, up(0)), (8, down(0)), (56, up(0)), (120, up(1)), (176, down(1)), (232, up(1))];
        assert!(kinds(&samples).is_empty());
    }

    #[test]
    fn another_modifier_held_with_option_cancels() {
        let with_shift = KeyState { option: true, other_modifier: true, key_downs: 0 };
        let samples = [(0, up(0)), (8, with_shift), (56, up(0)), (120, down(0)), (168, up(0))];
        assert!(kinds(&samples).is_empty());
    }

    #[test]
    fn holding_option_talks_from_the_hold_time_until_release() {
        let gestures = run(&[(0, up(0)), (8, down(0)), (1200, up(0)), (1300, up(0))]);
        // Pressed at 8 ms, so the first sample at least HOLD_MS later is 312 ms.
        assert_eq!(gestures, vec![(312, HoldStart), (1200, HoldEnd)]);
    }

    #[test]
    fn a_hold_is_not_half_of_a_double_tap() {
        // A tap, then a hold within the double-tap window: talking, not summoning.
        let samples = [(0, up(0)), (8, down(0)), (64, up(0)), (160, down(0)), (900, up(0)), (1000, up(0))];
        assert_eq!(kinds(&samples), vec![HoldStart, HoldEnd]);
        // A hold, then a quick tap: no summon either.
        let samples = [(0, up(0)), (8, down(0)), (800, up(0)), (880, down(0)), (936, up(0)), (1100, up(0))];
        assert_eq!(kinds(&samples), vec![HoldStart, HoldEnd]);
    }

    #[test]
    fn a_double_tap_never_starts_talking() {
        let samples = [(0, up(0)), (8, down(0)), (200, up(0)), (296, down(0)), (496, up(0)), (900, up(0))];
        assert_eq!(kinds(&samples), vec![Summon]);
    }

    #[test]
    fn a_tap_while_listening_sends_and_does_not_count_toward_a_summon() {
        let mut gestures = OptionGestures::default();
        let mut at = |t: u64, s: KeyState| gestures.sample(t, s, true);
        assert_eq!(at(0, down(0)), None);
        assert_eq!(at(80, up(0)), Some(Send));
        // A quick tap after the send is the first of a new pair, not a summon.
        assert_eq!(at(160, down(0)), None);
        assert_eq!(at(220, up(0)), Some(Send));
    }

    #[test]
    fn a_press_while_listening_never_starts_another_hold() {
        let mut gestures = OptionGestures::default();
        assert_eq!(gestures.sample(0, down(0), true), None);
        assert_eq!(gestures.sample(500, down(0), true), None);
        assert_eq!(gestures.sample(600, up(0), true), None);
    }

    #[test]
    fn a_key_pressed_during_a_hold_still_ends_it_on_release() {
        let samples = [(0, up(0)), (8, down(0)), (500, down(1)), (700, up(1)), (800, up(1))];
        assert_eq!(kinds(&samples), vec![HoldStart, HoldEnd]);
    }
}
