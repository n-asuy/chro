use std::time::SystemTime;

use chrono::{DateTime, Utc};

pub(crate) fn format_system_time(time: Option<SystemTime>) -> Option<String> {
    time.map(|ts| DateTime::<Utc>::from(ts).to_rfc3339())
}
