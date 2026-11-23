//! Press to talk: the microphone through the system's on-device speech
//! recognition, in the language of the system locale. Partial transcripts
//! stream to the windows as `edge-talk` events while listening; when talking
//! ends with a send, the audio is closed and the recognizer's final result is
//! awaited (briefly), so the last words are not lost. Recognizer errors reach
//! the renderer as `edge-talk-error` with a readable message, never silence.
//! Nothing leaves the Mac: recognition is required to run on the device.
//!
//! The newer speech API of macOS 26 is Swift-only, so this uses the
//! Objective-C recognizer with on-device recognition required. The language
//! is the one chosen in the edge settings, else Japanese when Japanese is
//! among the system's languages, else the system's language
//! ([`talk_locale`]).
//!
//! Diagnostics: with `CHRO_EDGE_TALK_AUDIO_FILE` set to an audio file, the
//! same pipeline is fed from that file (at its own pace, as a microphone
//! would) instead of the microphone, and a probe runs it once at startup;
//! every stage logs under `[edge] talk`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime as TauriRuntime};
use tracing::debug;

use super::privacy::{access, first_missing, Access, Privacy};
use crate::error::{DesktopError, DesktopResult};

/// Event carrying the transcript so far.
pub const TALK_EVENT: &str = "edge-talk";

/// Event carrying the microphone's input level (see `talk_level`).
pub const LEVEL_EVENT: &str = "edge-talk-level";

/// Event carrying a recognizer error.
pub const ERROR_EVENT: &str = "edge-talk-error";

/// Environment variable naming an audio file to use instead of the microphone.
pub const AUDIO_FILE_ENV: &str = "CHRO_EDGE_TALK_AUDIO_FILE";

/// How long a send waits for the recognizer's final result after the audio ends.
const FINAL_WAIT: Duration = Duration::from_millis(1500);

/// Levels of the chunks one audio buffer completed, oldest first, each
/// [`super::talk_level::CHUNK_MS`] long.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkLevels {
    pub levels: Vec<f32>,
    pub interval_ms: f64,
}

/// Set while the microphone is listening; the Option gestures read it.
static LISTENING: AtomicBool = AtomicBool::new(false);

/// Bumped by every start and stop, so callbacks of an ended session are dropped.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// What the recognizer has said in the session of a generation.
#[derive(Debug, Default, Clone)]
struct Heard {
    generation: u64,
    text: String,
    is_final: bool,
    results: u32,
    error: Option<String>,
}

static HEARD: Mutex<Option<Heard>> = Mutex::new(None);

fn update_heard(generation: u64, change: impl FnOnce(&mut Heard)) {
    if let Ok(mut heard) = HEARD.lock() {
        let entry = heard.get_or_insert_with(Heard::default);
        if entry.generation != generation {
            *entry = Heard { generation, ..Heard::default() };
        }
        change(entry);
    }
}

fn heard(generation: u64) -> Heard {
    HEARD
        .lock()
        .ok()
        .and_then(|heard| heard.clone())
        .filter(|heard| heard.generation == generation)
        .unwrap_or_default()
}

/// Whether the toolbar is listening.
pub fn listening() -> bool {
    LISTENING.load(Ordering::SeqCst)
}

/// Which window's input the words are for: the toolbar's talk pill, or the
/// capture's ask field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TalkOwner {
    Toolbar,
    Capture,
}

/// The transcript so far.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkUpdate {
    pub owner: TalkOwner,
    pub text: String,
    pub is_final: bool,
}

/// A recognizer error, worded for the person.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkError {
    pub owner: TalkOwner,
    pub message: String,
    /// Nothing was said: not a failure, the pill just closes.
    pub no_speech: bool,
}

/// How a start went.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum TalkStart {
    Started,
    /// A permission is off; the renderer offers its System Settings pane.
    Blocked { privacy: Privacy },
    /// The system cannot listen (no on-device model for the language, no
    /// microphone, an older system); `reason` is shown as is.
    Unavailable { reason: String },
    /// Talking ended before listening began (released during a dialog).
    Cancelled,
}

/// What a recognizer error means for the person, from its domain and code.
/// `None` for errors that only mean the session was ended on purpose.
pub fn describe_error(domain: &str, code: i64, description: &str, locale: &str) -> Option<(String, bool)> {
    match (domain, code) {
        // The task was cancelled (talking ended without a send).
        ("kAFAssistantErrorDomain", 216 | 209 | 301) | ("kLSRErrorDomain", 301) => None,
        ("kAFAssistantErrorDomain", 1110) => Some(("No speech was heard.".into(), true)),
        ("kLSRErrorDomain", 102) => Some((
            format!(
                "The on-device speech model for {locale} is not installed. Turn on Dictation \
                 for this language in System Settings > Keyboard to download it."
            ),
            false,
        )),
        ("kLSRErrorDomain", 201) => Some((
            "Dictation is turned off. Turn it on in System Settings > Keyboard to talk on this Mac."
                .into(),
            false,
        )),
        _ => Some((format!("Speech recognition stopped: {description} ({domain} {code})."), false)),
    }
}

/// Where the audio comes from.
#[derive(Debug, Clone, PartialEq)]
pub enum AudioSource {
    Microphone,
    /// An audio file played into the recognizer at its own pace (diagnostics).
    File(std::path::PathBuf),
}

pub fn audio_source() -> AudioSource {
    match std::env::var_os(AUDIO_FILE_ENV) {
        Some(path) if !path.is_empty() => AudioSource::File(path.into()),
        _ => AudioSource::Microphone,
    }
}

/// A locale identifier in one spelling (ja_JP and ja-JP are the same).
fn norm_locale(id: &str) -> String {
    id.replace('_', "-")
}

fn find_locale(supported: &[String], id: &str) -> Option<String> {
    let id = norm_locale(id);
    supported.iter().map(|s| norm_locale(s)).find(|s| s.eq_ignore_ascii_case(&id))
}

/// The talk language when the person has not chosen one: Japanese when
/// Japanese is among the system's preferred languages, otherwise the first
/// preferred language the recognizer supports on the device (its own region
/// when the preferred one has none, ja-JP, de-DE). `None` leaves it to the
/// system's default recognizer.
pub fn default_talk_locale(preferred: &[String], supported: &[String]) -> Option<String> {
    let language = |id: &str| norm_locale(id).split('-').next().unwrap_or_default().to_lowercase();
    if preferred.iter().any(|p| language(p) == "ja") {
        if let Some(ja) = find_locale(supported, "ja-JP") {
            return Some(ja);
        }
    }
    preferred.iter().find_map(|p| {
        find_locale(supported, p).or_else(|| {
            let lang = language(p);
            find_locale(supported, &format!("{lang}-{}", lang.to_uppercase()))
        })
    })
}

/// The talk language: the person's choice when the device can recognize it,
/// otherwise the default (see [`default_talk_locale`]).
pub fn talk_locale(chosen: Option<&str>, preferred: &[String], supported: &[String]) -> Option<String> {
    chosen
        .and_then(|id| find_locale(supported, id))
        .or_else(|| default_talk_locale(preferred, supported))
}

/// The languages the settings offer: the locales with an on-device
/// recognizer, and what "automatic" resolves to.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkLanguages {
    pub automatic: Option<String>,
    pub locales: Vec<String>,
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::AllocAnyThread;
    use objc2_avf_audio::{AVAudioEngine, AVAudioFile, AVAudioPCMBuffer, AVAudioTime};
    use objc2_foundation::{NSError, NSURL};
    use objc2_speech::{
        SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
        SFSpeechRecognizer,
    };
    use tauri::{AppHandle, Emitter, Runtime as TauriRuntime};
    use tracing::debug;

    use super::super::talk_level::{LevelMeter, CHUNK_MS};
    use super::{
        describe_error, talk_locale, update_heard, AudioSource, TalkError, TalkLevels, TalkOwner, TalkStart,
        TalkUpdate, ERROR_EVENT, GENERATION, LEVEL_EVENT, TALK_EVENT,
    };

    /// The running session; only ever touched on the main thread.
    struct Session {
        engine: Option<Retained<AVAudioEngine>>,
        request: Retained<SFSpeechAudioBufferRecognitionRequest>,
        task: Retained<SFSpeechRecognitionTask>,
        _recognizer: Retained<SFSpeechRecognizer>,
    }

    thread_local! {
        static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
    }

    /// The system's preferred languages and the recognizer's locales with
    /// on-device recognition. Main thread.
    fn languages() -> (Vec<String>, Vec<String>) {
        let preferred: Vec<String> =
            objc2_foundation::NSLocale::preferredLanguages().iter().map(|s| s.to_string()).collect();
        let on_device: Vec<String> = unsafe { SFSpeechRecognizer::supportedLocales() }
            .iter()
            .filter(|locale| {
                unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), locale) }
                    .is_some_and(|r| unsafe { r.supportsOnDeviceRecognition() })
            })
            .map(|locale| locale.localeIdentifier().to_string())
            .collect();
        (preferred, on_device)
    }

    /// The locales the settings offer and what "automatic" resolves to. Main thread.
    pub fn talk_languages() -> super::TalkLanguages {
        if !super::super::privacy::load_framework("Speech")
            || objc2::runtime::AnyClass::get(c"SFSpeechRecognizer").is_none()
        {
            return super::TalkLanguages { automatic: None, locales: Vec::new() };
        }
        let (preferred, mut locales) = languages();
        locales.sort();
        super::TalkLanguages { automatic: super::default_talk_locale(&preferred, &locales), locales }
    }

    /// The recognizer for talking in `chosen` (see `talk_locale`), and how it
    /// was chosen. Main thread.
    fn recognizer(chosen: Option<&str>) -> Option<(Retained<SFSpeechRecognizer>, String)> {
        let (preferred, on_device) = languages();
        let locale = talk_locale(chosen, &preferred, &on_device);
        let recognizer = match &locale {
            Some(id) => unsafe {
                let locale = objc2_foundation::NSLocale::localeWithLocaleIdentifier(
                    &objc2_foundation::NSString::from_str(id),
                );
                SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale)
            },
            None => unsafe { SFSpeechRecognizer::init(SFSpeechRecognizer::alloc()) },
        }?;
        let how = format!("chosen={chosen:?} preferred={preferred:?} locale={locale:?}");
        Some((recognizer, how))
    }

    fn unavailable(reason: impl Into<String>) -> TalkStart {
        let reason = reason.into();
        debug!("[edge] talk unavailable: {reason}");
        TalkStart::Unavailable { reason }
    }

    /// The request, handed to the thread that plays a file into it. Appending
    /// buffers from another thread is what the microphone tap does too.
    struct SendRequest(Retained<SFSpeechAudioBufferRecognitionRequest>);
    // SAFETY: the request is only appended to (thread-safe in the framework,
    // as the audio tap's own thread does) and released.
    unsafe impl Send for SendRequest {}

    /// Feeds buffers to the recognizer and the level meter, counting them.
    struct Feed<R: TauriRuntime> {
        request: Retained<SFSpeechAudioBufferRecognitionRequest>,
        meter: std::sync::Mutex<LevelMeter>,
        app: AppHandle<R>,
        generation: u64,
        appended: AtomicU32,
    }

    impl<R: TauriRuntime> Feed<R> {
        fn push(&self, buffer: &AVAudioPCMBuffer, sample_rate: f64) {
            if GENERATION.load(Ordering::SeqCst) != self.generation {
                return;
            }
            unsafe { self.request.appendAudioPCMBuffer(buffer) };
            let count = self.appended.fetch_add(1, Ordering::SeqCst) + 1;
            if count == 1 || count % 20 == 0 {
                debug!("[edge] talk buffers appended {count}");
            }
            // The first channel's float samples (deinterleaved float).
            let channels = unsafe { buffer.floatChannelData() };
            if channels.is_null() {
                return;
            }
            let frames = unsafe { buffer.frameLength() } as usize;
            let samples = unsafe { std::slice::from_raw_parts((*channels).as_ptr(), frames) };
            let levels = match self.meter.lock() {
                Ok(mut meter) => meter.feed(samples, sample_rate),
                Err(_) => return,
            };
            if !levels.is_empty() {
                let _ = self.app.emit(LEVEL_EVENT, TalkLevels { levels, interval_ms: CHUNK_MS });
            }
        }
    }

    /// Start listening. Main thread.
    pub fn start<R: TauriRuntime>(
        app: AppHandle<R>,
        owner: TalkOwner,
        generation: u64,
        source: AudioSource,
        language: Option<String>,
    ) -> TalkStart {
        stop();
        if GENERATION.load(Ordering::SeqCst) != generation {
            return TalkStart::Cancelled;
        }
        if !super::super::privacy::load_framework("Speech")
            || objc2::runtime::AnyClass::get(c"SFSpeechRecognizer").is_none()
            || objc2::runtime::AnyClass::get(c"AVAudioEngine").is_none()
        {
            return unavailable("This version of macOS cannot listen.");
        }
        let Some((recognizer, how)) = recognizer(language.as_deref()) else {
            return unavailable("Speech recognition does not support this language.");
        };
        let locale = unsafe { recognizer.locale().localeIdentifier() }.to_string();
        let on_device = unsafe { recognizer.supportsOnDeviceRecognition() };
        let available = unsafe { recognizer.isAvailable() };
        debug!("[edge] talk language {how}");
        debug!("[edge] talk recognizer locale={locale} on_device={on_device} available={available}");
        if !on_device {
            return unavailable(format!(
                "On-device speech recognition is not available for {locale}."
            ));
        }
        if !available {
            return unavailable("Speech recognition is not available right now.");
        }

        let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
        unsafe {
            request.setShouldReportPartialResults(true);
            request.setRequiresOnDeviceRecognition(true);
        }

        let results = Arc::new(AtomicU32::new(0));
        let error_app = app.clone();
        let result_app = app.clone();
        let error_locale = locale.clone();
        let handler = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
            if GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            if let Some(result) = unsafe { result.as_ref() } {
                let text = unsafe { result.bestTranscription().formattedString() }.to_string();
                let is_final = unsafe { result.isFinal() };
                let n = results.fetch_add(1, Ordering::SeqCst) + 1;
                debug!("[edge] talk result #{n} len={} final={is_final} emitted", text.chars().count());
                update_heard(generation, |heard| {
                    heard.text.clone_from(&text);
                    heard.is_final = is_final;
                    heard.results = n;
                });
                let _ = result_app.emit(TALK_EVENT, TalkUpdate { owner, text, is_final });
            }
            if let Some(error) = unsafe { error.as_ref() } {
                let domain = error.domain().to_string();
                let code = error.code() as i64;
                let description = error.localizedDescription().to_string();
                debug!("[edge] talk recognizer error domain={domain} code={code} {description}");
                let described = describe_error(&domain, code, &description, &error_locale);
                update_heard(generation, |heard| {
                    heard.is_final = true;
                    heard.error = described.as_ref().map(|(message, _)| message.clone());
                });
                if let Some((message, no_speech)) = described {
                    let _ = error_app.emit(ERROR_EVENT, TalkError { owner, message, no_speech });
                }
            }
        });
        let task = unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };

        let engine = match source {
            AudioSource::Microphone => {
                let engine = unsafe { AVAudioEngine::new() };
                let input = unsafe { engine.inputNode() };
                let format = unsafe { input.outputFormatForBus(0) };
                let sample_rate = unsafe { format.sampleRate() };
                let channels = unsafe { format.channelCount() };
                if channels == 0 {
                    unsafe { task.cancel() };
                    return unavailable("No microphone is available.");
                }
                let tap_feed = Feed {
                    request: request.clone(),
                    meter: std::sync::Mutex::new(LevelMeter::default()),
                    app: app.clone(),
                    generation,
                    appended: AtomicU32::new(0),
                };
                let tap = RcBlock::new(move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
                    tap_feed.push(unsafe { buffer.as_ref() }, sample_rate);
                });
                unsafe {
                    input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), RcBlock::as_ptr(&tap));
                    engine.prepare();
                }
                if let Err(err) = unsafe { engine.startAndReturnError() } {
                    unsafe {
                        input.removeTapOnBus(0);
                        task.cancel();
                    }
                    return unavailable(err.localizedDescription().to_string());
                }
                debug!("[edge] talk audio engine started format={sample_rate}Hz {channels}ch");
                Some(engine)
            }
            AudioSource::File(path) => {
                let request = SendRequest(request.clone());
                let file_app = app.clone();
                debug!("[edge] talk audio file {}", path.display());
                std::thread::spawn(move || play_file(&path, request, file_app, generation));
                None
            }
        };
        SESSION.with(|session| {
            *session.borrow_mut() = Some(Session { engine, request, task, _recognizer: recognizer });
        });
        TalkStart::Started
    }

    /// Play an audio file into the request in 100 ms buffers, one every
    /// 100 ms, as a microphone would deliver them.
    fn play_file<R: TauriRuntime>(path: &std::path::Path, request: SendRequest, app: AppHandle<R>, generation: u64) {
        let url = NSURL::fileURLWithPath(&objc2_foundation::NSString::from_str(&path.to_string_lossy()));
        let file = match unsafe { AVAudioFile::initForReading_error(AVAudioFile::alloc(), &url) } {
            Ok(file) => file,
            Err(err) => {
                debug!("[edge] talk audio file unreadable: {}", err.localizedDescription());
                return;
            }
        };
        let format = unsafe { file.processingFormat() };
        let sample_rate = unsafe { format.sampleRate() };
        let total = unsafe { file.length() };
        debug!(
            "[edge] talk audio file format={sample_rate}Hz {}ch frames={total}",
            unsafe { format.channelCount() }
        );
        let feed = Feed {
            request: request.0,
            meter: std::sync::Mutex::new(LevelMeter::default()),
            app,
            generation,
            appended: AtomicU32::new(0),
        };
        let step = (sample_rate / 10.0).round().max(1.0) as u32;
        loop {
            if GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let Some(buffer) =
                (unsafe { AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(AVAudioPCMBuffer::alloc(), &format, step) })
            else {
                return;
            };
            if unsafe { file.readIntoBuffer_error(&buffer) }.is_err() || unsafe { buffer.frameLength() } == 0 {
                debug!("[edge] talk audio file ended after {} buffers", feed.appended.load(Ordering::SeqCst));
                return;
            }
            feed.push(&buffer, sample_rate);
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    /// The recognizer's locale and on-device support (needs no permission).
    /// Main thread.
    pub fn describe_recognizer() -> String {
        if !super::super::privacy::load_framework("Speech")
            || objc2::runtime::AnyClass::get(c"SFSpeechRecognizer").is_none()
        {
            return "no recognizer on this system".into();
        }
        match recognizer(None) {
            Some((recognizer, how)) => unsafe {
                format!(
                    "locale={} on_device={} available={} ({how})",
                    recognizer.locale().localeIdentifier(),
                    recognizer.supportsOnDeviceRecognition(),
                    recognizer.isAvailable()
                )
            },
            None => "no recognizer for this language".into(),
        }
    }

    /// Close the audio but let the recognizer finish. Main thread.
    pub fn end_audio() {
        SESSION.with(|session| {
            if let Some(session) = session.borrow().as_ref() {
                unsafe {
                    if let Some(engine) = &session.engine {
                        engine.stop();
                        engine.inputNode().removeTapOnBus(0);
                    }
                    session.request.endAudio();
                }
                debug!("[edge] talk audio ended, waiting for the final result");
            }
        });
    }

    /// Stop listening and end the recognition. Main thread.
    pub fn stop() {
        let Some(session) = SESSION.with(|session| session.borrow_mut().take()) else {
            return;
        };
        unsafe {
            if let Some(engine) = &session.engine {
                engine.stop();
                engine.inputNode().removeTapOnBus(0);
            }
            session.request.endAudio();
            session.task.cancel();
        }
        debug!("[edge] talk stopped");
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use tauri::{AppHandle, Runtime as TauriRuntime};

    use super::{AudioSource, TalkOwner, TalkStart};

    pub fn start<R: TauriRuntime>(
        _app: AppHandle<R>,
        _owner: TalkOwner,
        _generation: u64,
        _source: AudioSource,
        _language: Option<String>,
    ) -> TalkStart {
        TalkStart::Unavailable { reason: "Talking is available on macOS only.".into() }
    }

    pub fn end_audio() {}

    pub fn stop() {}

    pub fn describe_recognizer() -> String {
        "no recognizer on this system".into()
    }

    pub fn talk_languages() -> super::TalkLanguages {
        super::TalkLanguages { automatic: None, locales: Vec::new() }
    }
}

fn main_thread_error(what: &str, err: impl std::fmt::Display) -> DesktopError {
    DesktopError::from(anyhow::anyhow!("{what}: {err}"))
}

/// Start a session on the main thread.
async fn start_session<R: TauriRuntime>(
    app: &AppHandle<R>,
    owner: TalkOwner,
    generation: u64,
    language: Option<String>,
) -> DesktopResult<TalkStart> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    let source = audio_source();
    app.run_on_main_thread(move || {
        let _ = tx.send(platform::start(handle, owner, generation, source, language));
    })
    .map_err(|err| main_thread_error("start listening", err))?;
    let outcome = rx.await.map_err(|_| main_thread_error("start listening", "no answer"))?;
    if outcome == TalkStart::Started {
        LISTENING.store(true, Ordering::SeqCst);
    }
    debug!("[edge] talk start {outcome:?} generation={generation}");
    Ok(outcome)
}

/// End the session; with `finish`, close the audio first and wait for the
/// recognizer's final result. Returns what was heard.
async fn end_session<R: TauriRuntime>(app: &AppHandle<R>, finish: bool) -> DesktopResult<String> {
    LISTENING.store(false, Ordering::SeqCst);
    let generation = GENERATION.load(Ordering::SeqCst);
    if finish {
        app.run_on_main_thread(platform::end_audio)
            .map_err(|err| main_thread_error("stop listening", err))?;
        let started = Instant::now();
        while !heard(generation).is_final && started.elapsed() < FINAL_WAIT {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        let result = heard(generation);
        debug!(
            "[edge] talk final len={} final={} results={} error={:?} waited={}ms",
            result.text.chars().count(),
            result.is_final,
            result.results,
            result.error,
            started.elapsed().as_millis()
        );
    }
    let text = heard(generation).text;
    GENERATION.fetch_add(1, Ordering::SeqCst);
    app.run_on_main_thread(platform::stop)
        .map_err(|err| main_thread_error("stop listening", err))?;
    Ok(text)
}

/// Start listening, after asking for the microphone and speech recognition
/// if they were never decided.
#[tauri::command]
pub async fn edge_talk_start<R: TauriRuntime>(
    app: AppHandle<R>,
    owner: TalkOwner,
    language: Option<String>,
) -> DesktopResult<TalkStart> {
    // Taken first, so a stop during a permission dialog cancels this start.
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(privacy) = first_missing(&[Privacy::Microphone, Privacy::SpeechRecognition]).await {
        debug!("[edge] talk start blocked by {privacy:?}");
        return Ok(TalkStart::Blocked { privacy });
    }
    start_session(&app, owner, generation, language).await
}

/// The talk languages the settings offer (locales recognized on the device)
/// and what "automatic" resolves to.
#[tauri::command]
pub async fn edge_talk_languages<R: TauriRuntime>(app: AppHandle<R>) -> DesktopResult<TalkLanguages> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(platform::talk_languages());
    })
    .map_err(|err| main_thread_error("talk languages", err))?;
    rx.await.map_err(|_| main_thread_error("talk languages", "no answer"))
}

/// Stop listening. With `finish` (a send), the recognizer's final result is
/// awaited and returned; without it, what was heard is dropped.
#[tauri::command]
pub async fn edge_talk_stop<R: TauriRuntime>(
    app: AppHandle<R>,
    finish: Option<bool>,
) -> DesktopResult<String> {
    let finish = finish.unwrap_or(false);
    debug!("[edge] talk stop finish={finish}");
    end_session(&app, finish).await
}

/// A line from the renderer into the shell's log (talk diagnostics).
#[tauri::command]
pub fn edge_log(message: String) {
    debug!("[edge] renderer: {message}");
}

/// Diagnostics at startup: log the recognizer's locale and on-device
/// support; with an audio file configured, also run it through the
/// recognizer once, when speech recognition is already allowed (it never
/// asks), and log what is heard.
pub fn spawn_probe<R: TauriRuntime>(app: AppHandle<R>) {
    let _ = app.run_on_main_thread(|| debug!("[edge] talk recognizer {}", platform::describe_recognizer()));
    let AudioSource::File(path) = audio_source() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if access(Privacy::SpeechRecognition) != Access::Granted {
            debug!("[edge] talk probe skipped: speech recognition is not allowed");
            return;
        }
        debug!("[edge] talk probe start {}", path.display());
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        match start_session(&app, TalkOwner::Toolbar, generation, None).await {
            Ok(TalkStart::Started) => {}
            other => {
                debug!("[edge] talk probe did not start: {other:?}");
                return;
            }
        }
        // The file's length plus a little, as a person would hold the key.
        let seconds = std::fs::metadata(&path).map(|m| m.len() as f64 / 64_000.0).unwrap_or(4.0);
        tokio::time::sleep(Duration::from_secs_f64(seconds.clamp(1.0, 20.0) + 0.5)).await;
        match end_session(&app, true).await {
            Ok(text) => debug!("[edge] talk probe heard: {text}"),
            Err(err) => debug!("[edge] talk probe failed: {err}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_start_reports_its_outcome_by_name() {
        let blocked = TalkStart::Blocked { privacy: Privacy::Microphone };
        assert_eq!(
            serde_json::to_value(&blocked).unwrap(),
            serde_json::json!({ "outcome": "blocked", "privacy": "microphone" })
        );
        assert_eq!(
            serde_json::to_value(TalkStart::Started).unwrap(),
            serde_json::json!({ "outcome": "started" })
        );
    }

    #[test]
    fn an_update_names_its_owner() {
        let update = TalkUpdate { owner: TalkOwner::Capture, text: "これ".into(), is_final: false };
        assert_eq!(
            serde_json::to_value(update).unwrap(),
            serde_json::json!({ "owner": "capture", "text": "これ", "isFinal": false })
        );
    }

    #[test]
    fn a_missing_on_device_model_is_named_with_its_locale() {
        let (message, no_speech) =
            describe_error("kLSRErrorDomain", 102, "Assets are not installed", "ja_JP").unwrap();
        assert!(message.contains("ja_JP") && message.contains("Dictation"));
        assert!(!no_speech);
    }

    #[test]
    fn no_speech_is_not_a_failure_and_cancels_are_silent() {
        assert_eq!(
            describe_error("kAFAssistantErrorDomain", 1110, "No speech detected", "ja_JP"),
            Some(("No speech was heard.".into(), true))
        );
        assert_eq!(describe_error("kAFAssistantErrorDomain", 216, "canceled", "ja_JP"), None);
    }

    #[test]
    fn other_errors_keep_their_domain_and_code() {
        let (message, _) = describe_error("SFSpeechErrorDomain", 1, "Internal error", "ja_JP").unwrap();
        assert!(message.contains("Internal error") && message.contains("SFSpeechErrorDomain 1"));
    }

    #[test]
    fn what_was_heard_belongs_to_its_session() {
        update_heard(9001, |heard| heard.text = "前".into());
        update_heard(9002, |heard| heard.text = "後".into());
        assert_eq!(heard(9002).text, "後");
        assert_eq!(heard(9001).text, "");
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn japanese_in_the_system_languages_makes_japanese_the_default() {
        let supported = strings(&["en-US", "en_GB", "ja_JP", "de-DE"]);
        // English first, Japanese second (this Mac): still Japanese.
        assert_eq!(default_talk_locale(&strings(&["en-JP", "ja-JP"]), &supported), Some("ja-JP".into()));
    }

    #[test]
    fn otherwise_the_first_system_language_the_device_recognizes() {
        let supported = strings(&["en-US", "en-GB", "de_DE"]);
        assert_eq!(default_talk_locale(&strings(&["en-GB", "de-DE"]), &supported), Some("en-GB".into()));
        // German without a region takes its own (de-DE).
        assert_eq!(default_talk_locale(&strings(&["de"]), &supported), Some("de-DE".into()));
        // en-JP is no recognizer locale and there is no "en-EN": the next
        // language, German, in its own region.
        assert_eq!(default_talk_locale(&strings(&["en-JP", "de-AT"]), &supported), Some("de-DE".into()));
        // Nothing the device recognizes: the system's default recognizer.
        assert_eq!(default_talk_locale(&strings(&["ko-KR"]), &supported), None);
    }

    #[test]
    fn japanese_without_a_recognizer_falls_back_to_the_rest() {
        let supported = strings(&["en-US"]);
        assert_eq!(default_talk_locale(&strings(&["ja-JP", "en-US"]), &supported), Some("en-US".into()));
    }

    #[test]
    fn a_chosen_language_wins_when_the_device_recognizes_it() {
        let supported = strings(&["en-US", "ja-JP", "fr-FR"]);
        let preferred = strings(&["en-JP", "ja-JP"]);
        assert_eq!(talk_locale(Some("fr_FR"), &preferred, &supported), Some("fr-FR".into()));
        // No longer recognized on the device: back to the default.
        assert_eq!(talk_locale(Some("ko-KR"), &preferred, &supported), Some("ja-JP".into()));
        assert_eq!(talk_locale(None, &preferred, &supported), Some("ja-JP".into()));
    }

    #[test]
    fn the_microphone_is_the_source_unless_a_file_is_configured() {
        // The test process never sets the variable.
        if std::env::var_os(AUDIO_FILE_ENV).is_none() {
            assert_eq!(audio_source(), AudioSource::Microphone);
        }
    }
}
