//! The microphone's input level while listening, for the toolbar's level
//! meter (the bars on the microphone button).
//!
//! The audio tap delivers buffers of whatever length the system chooses
//! (often about 100 ms on macOS), so the samples are cut into chunks of
//! [`CHUNK_MS`] regardless of buffer boundaries: each chunk gives one level,
//! about 30 per second. A level is the chunk's RMS on a decibel scale mapped
//! to 0..1 ([`FLOOR_DB`] and below is silence, [`CEIL_DB`] and above is full),
//! smoothed so it rises quickly with the voice and falls back calmly.

/// Length of one level's chunk.
pub const CHUNK_MS: f64 = 1000.0 / 30.0;

/// RMS at or below this is shown as silence (room noise).
pub const FLOOR_DB: f32 = -55.0;

/// RMS at or above this fills the meter (a raised voice).
pub const CEIL_DB: f32 = -12.0;

/// Share of the way to a louder level taken per chunk.
const ATTACK: f32 = 0.7;

/// Share of the way to a quieter level taken per chunk.
const RELEASE: f32 = 0.25;

/// A chunk's RMS mapped to 0..1 on the meter's decibel scale.
pub fn level_from_rms(rms: f32) -> f32 {
    if !rms.is_finite() || rms <= 0.0 {
        return 0.0;
    }
    let db = 20.0 * rms.log10();
    ((db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)).clamp(0.0, 1.0)
}

/// Turns sample buffers into smoothed levels, one per chunk.
#[derive(Debug, Default)]
pub struct LevelMeter {
    /// Sum of squares and count of the chunk being filled.
    sum: f64,
    count: usize,
    /// The smoothed level of the last chunk.
    level: f32,
}

impl LevelMeter {
    /// Feed one buffer of mono samples; returns the levels of the chunks it
    /// completed (none when it only partly filled one).
    pub fn feed(&mut self, samples: &[f32], sample_rate: f64) -> Vec<f32> {
        let chunk = ((sample_rate * CHUNK_MS / 1000.0).round() as usize).max(1);
        let mut levels = Vec::new();
        for &sample in samples {
            let sample = f64::from(sample);
            self.sum += sample * sample;
            self.count += 1;
            if self.count == chunk {
                let rms = (self.sum / self.count as f64).sqrt() as f32;
                let target = level_from_rms(rms);
                let rate = if target > self.level { ATTACK } else { RELEASE };
                self.level += (target - self.level) * rate;
                // Silence settles on a steady 0 rather than a long tail.
                if self.level < 0.005 {
                    self.level = 0.0;
                }
                levels.push(self.level);
                self.sum = 0.0;
                self.count = 0;
            }
        }
        levels
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 48_000.0;

    /// One chunk of a sine at `amplitude` (its RMS is amplitude / sqrt 2).
    fn tone(amplitude: f32, chunks: usize) -> Vec<f32> {
        let n = (RATE * CHUNK_MS / 1000.0).round() as usize * chunks;
        (0..n)
            .map(|i| amplitude * (i as f32 * 0.07).sin())
            .collect()
    }

    #[test]
    fn silence_and_room_noise_read_as_zero() {
        assert_eq!(level_from_rms(0.0), 0.0);
        assert_eq!(level_from_rms(0.001), 0.0); // -60 dBFS
        assert_eq!(level_from_rms(f32::NAN), 0.0);
    }

    #[test]
    fn a_raised_voice_fills_the_meter_and_levels_between_are_on_a_decibel_scale() {
        assert_eq!(level_from_rms(0.5), 1.0);
        let mid = 10f32.powf((FLOOR_DB + CEIL_DB) / 2.0 / 20.0);
        assert!((level_from_rms(mid) - 0.5).abs() < 1e-4);
    }

    #[test]
    fn one_level_per_chunk_whatever_the_buffer_length() {
        let mut meter = LevelMeter::default();
        let samples = tone(0.1, 6);
        // A 100 ms buffer, then the rest in odd-sized pieces.
        let first = samples.len() / 2;
        let mut levels = meter.feed(&samples[..first], RATE);
        for piece in samples[first..].chunks(333) {
            levels.extend(meter.feed(piece, RATE));
        }
        assert_eq!(levels.len(), 6);
    }

    #[test]
    fn rises_quickly_with_the_voice_and_falls_back_calmly() {
        let mut meter = LevelMeter::default();
        let rising = meter.feed(&tone(0.2, 3), RATE);
        let target = level_from_rms(0.2 / 2f32.sqrt());
        assert!(rising[0] >= target * 0.65, "first chunk already most of the way: {rising:?}");
        assert!(rising[2] > rising[0]);
        let falling = meter.feed(&vec![0.0; tone(0.0, 3).len()], RATE);
        assert!(falling[0] > 0.5 * rising[2], "no drop to zero at once: {falling:?}");
        assert!(falling[2] < falling[0]);
    }

    #[test]
    fn long_silence_settles_on_zero() {
        let mut meter = LevelMeter::default();
        meter.feed(&tone(0.3, 2), RATE);
        let levels = meter.feed(&vec![0.0; tone(0.0, 40).len()], RATE);
        assert_eq!(*levels.last().unwrap(), 0.0);
    }
}
