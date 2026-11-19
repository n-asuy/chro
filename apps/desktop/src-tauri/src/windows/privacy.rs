//! The privacy permissions the edge toolbar's voice input and region capture
//! need: reading each one's state, asking the system for one that was never
//! decided (the system shows its own dialog; the person decides), and opening
//! the System Settings pane where a denied one is turned on. Nothing here
//! grants a permission.

use serde::{Deserialize, Serialize};

use crate::error::{DesktopError, DesktopResult};

/// A permission the edge toolbar can need.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Privacy {
    Microphone,
    SpeechRecognition,
    ScreenRecording,
}

/// The state of one permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    Granted,
    Denied,
    /// Never asked; asking shows the system's dialog.
    Undetermined,
    /// Not available on this system.
    Unsupported,
}

/// All three, for the renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyStatus {
    pub microphone: Access,
    pub speech_recognition: Access,
    pub screen_recording: Access,
}

/// The System Settings pane for a permission.
pub fn settings_url(privacy: Privacy) -> &'static str {
    match privacy {
        Privacy::Microphone => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        Privacy::SpeechRecognition => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"
        }
        Privacy::ScreenRecording => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
    }
}

/// The first permission in `needed` that is not granted, after asking the
/// system for each undecided one in turn (its dialog; the person decides).
pub async fn first_missing(needed: &[Privacy]) -> Option<Privacy> {
    for &privacy in needed {
        let granted = match access(privacy) {
            Access::Granted => true,
            Access::Undetermined => request(privacy).await,
            Access::Denied | Access::Unsupported => false,
        };
        if !granted {
            return Some(privacy);
        }
    }
    None
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use objc2_speech::{SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus};
    use tokio::sync::oneshot;

    use super::{Access, Privacy};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    /// Whether an Objective-C class is present (the frameworks loaded on
    /// first use are missing on older systems).
    fn has_class(name: &std::ffi::CStr) -> bool {
        objc2::runtime::AnyClass::get(name).is_some()
    }

    /// Load a system framework the app does not link (its classes are looked
    /// up by name, so the linker keeps no reference to it). True when loaded.
    pub fn load_framework(name: &str) -> bool {
        let path = format!("/System/Library/Frameworks/{name}.framework/{name}");
        let Ok(path) = std::ffi::CString::new(path) else {
            return false;
        };
        // SAFETY: dlopen with a valid C string; a loaded framework stays
        // loaded for the life of the process.
        !unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY) }.is_null()
    }

    pub fn access(privacy: Privacy) -> Access {
        match privacy {
            Privacy::Microphone => {
                let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
                    return Access::Unsupported;
                };
                match unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) } {
                    AVAuthorizationStatus::Authorized => Access::Granted,
                    AVAuthorizationStatus::NotDetermined => Access::Undetermined,
                    _ => Access::Denied,
                }
            }
            Privacy::SpeechRecognition => {
                if !load_framework("Speech") || !has_class(c"SFSpeechRecognizer") {
                    return Access::Unsupported;
                }
                match unsafe { SFSpeechRecognizer::authorizationStatus() } {
                    SFSpeechRecognizerAuthorizationStatus::Authorized => Access::Granted,
                    SFSpeechRecognizerAuthorizationStatus::NotDetermined => Access::Undetermined,
                    _ => Access::Denied,
                }
            }
            // The system tells only granted or not; "not" is shown as denied,
            // and asking (once) shows its dialog.
            Privacy::ScreenRecording => {
                if unsafe { CGPreflightScreenCaptureAccess() } {
                    Access::Granted
                } else {
                    Access::Denied
                }
            }
        }
    }

    pub async fn request(privacy: Privacy) -> bool {
        match ask(privacy) {
            Asked::Pending(rx) => rx.await.unwrap_or(false),
            Asked::Done(granted) => granted,
        }
    }

    enum Asked {
        Pending(oneshot::Receiver<bool>),
        Done(bool),
    }

    /// Show the system's dialog. The blocks live only here (the system keeps
    /// its own copies), so the caller's future stays sendable.
    fn ask(privacy: Privacy) -> Asked {
        match privacy {
            Privacy::Microphone => {
                let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
                    return Asked::Done(false);
                };
                let (tx, rx) = oneshot::channel();
                let tx = std::sync::Mutex::new(Some(tx));
                let handler = block2::RcBlock::new(move |granted: Bool| {
                    if let Some(tx) = tx.lock().ok().and_then(|mut tx| tx.take()) {
                        let _ = tx.send(granted.as_bool());
                    }
                });
                unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler) };
                Asked::Pending(rx)
            }
            Privacy::SpeechRecognition => {
                if !load_framework("Speech") || !has_class(c"SFSpeechRecognizer") {
                    return Asked::Done(false);
                }
                let (tx, rx) = oneshot::channel();
                let tx = std::sync::Mutex::new(Some(tx));
                let handler = block2::RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
                    if let Some(tx) = tx.lock().ok().and_then(|mut tx| tx.take()) {
                        let _ = tx.send(status == SFSpeechRecognizerAuthorizationStatus::Authorized);
                    }
                });
                unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };
                Asked::Pending(rx)
            }
            // Shows the system's dialog the first time; it never waits for
            // the answer (granting takes effect after a relaunch).
            Privacy::ScreenRecording => Asked::Done(unsafe { CGRequestScreenCaptureAccess() }),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{Access, Privacy};

    pub fn load_framework(_name: &str) -> bool {
        false
    }

    pub fn access(_privacy: Privacy) -> Access {
        Access::Unsupported
    }

    pub async fn request(_privacy: Privacy) -> bool {
        false
    }
}

pub use platform::{access, load_framework, request};

/// The three permissions' states.
#[tauri::command]
pub fn edge_privacy_status() -> PrivacyStatus {
    PrivacyStatus {
        microphone: access(Privacy::Microphone),
        speech_recognition: access(Privacy::SpeechRecognition),
        screen_recording: access(Privacy::ScreenRecording),
    }
}

/// Open the System Settings pane for a permission.
#[tauri::command]
pub fn edge_open_privacy_settings(privacy: Privacy) -> DesktopResult<()> {
    std::process::Command::new("/usr/bin/open")
        .arg(settings_url(privacy))
        .status()
        .map_err(|err| DesktopError::from(anyhow::anyhow!("open System Settings: {err}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_permission_opens_its_own_privacy_pane() {
        assert!(settings_url(Privacy::Microphone).ends_with("Privacy_Microphone"));
        assert!(settings_url(Privacy::SpeechRecognition).ends_with("Privacy_SpeechRecognition"));
        assert!(settings_url(Privacy::ScreenRecording).ends_with("Privacy_ScreenCapture"));
    }

    #[test]
    fn permissions_travel_as_camel_case_names() {
        assert_eq!(serde_json::to_string(&Privacy::SpeechRecognition).unwrap(), "\"speechRecognition\"");
        let parsed: Privacy = serde_json::from_str("\"screenRecording\"").unwrap();
        assert_eq!(parsed, Privacy::ScreenRecording);
    }
}
