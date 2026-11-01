//! Plain-text renderings for people. Programs read the JSON envelope instead,
//! so nothing here is a contract.

use std::fmt::Write;

use server_contract::api::*;

use super::output::Human;

fn line(out: &mut String, label: &str, value: impl std::fmt::Display) {
    let _ = writeln!(out, "  {label:<9}{value}");
}

fn optional(out: &mut String, label: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
        line(out, label, value);
    }
}

fn clip(text: &str, max: usize) -> String {
    let single: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single.chars().count() <= max {
        single
    } else {
        let mut clipped: String = single.chars().take(max.saturating_sub(1)).collect();
        clipped.push('…');
        clipped
    }
}

fn reference(session: &SessionRef) -> String {
    format!("{} \"{}\"", session.handle(), clip(&session.title, 40))
}

fn turn_line(turn: &TurnView) -> String {
    let handle = turn.slug.clone().unwrap_or_else(|| turn.id.to_string());
    format!(
        "{handle} {} since {}",
        turn.status,
        turn.started_at.format("%Y-%m-%d %H:%M")
    )
}

impl Human for StatusView {
    fn human(&self) -> String {
        let mut out = format!("chro {} at {}\n", self.version, self.url);
        line(&mut out, "contract", &self.contract_rev);
        line(
            &mut out,
            "runtime",
            format!("{} (pid {})", self.runtime_id, self.pid),
        );
        let caller = match &self.caller {
            CallerView::User => "user".to_string(),
            CallerView::Agent { session } => format!("agent of session {}", reference(session)),
        };
        line(&mut out, "caller", caller);
        out
    }
}

impl Human for ProjectView {
    fn human(&self) -> String {
        let mut out = format!(
            "{}  {}\n",
            self.slug.clone().unwrap_or_else(|| self.id.to_string()),
            self.name
        );
        line(&mut out, "path", &self.path);
        out
    }
}

impl Human for ProjectList {
    fn human(&self) -> String {
        if self.projects.is_empty() {
            return "no projects".into();
        }
        let mut out = String::new();
        for project in &self.projects {
            let _ = writeln!(
                out,
                "{:<10} {:<24} {}",
                project.slug.as_deref().unwrap_or("-"),
                clip(&project.name, 24),
                project.path
            );
        }
        out
    }
}

impl Human for SessionView {
    fn human(&self) -> String {
        let mut out = format!("{}  {}\n", self.handle(), self.title);
        let state = match &self.turn {
            Some(turn) if self.state != SessionState::Idle => {
                format!("{} (turn {})", self.state.as_str(), turn_line(turn))
            }
            _ => self.state.as_str().to_string(),
        };
        line(&mut out, "state", state);
        line(&mut out, "status", &self.status);
        line(
            &mut out,
            "project",
            format!("{} ({})", self.project.name, self.project.path),
        );
        optional(&mut out, "agent", self.agent.as_deref());
        optional(&mut out, "branch", self.branch.as_deref());
        optional(&mut out, "worktree", self.worktree.as_deref());
        optional(&mut out, "note", self.note.as_deref());
        optional(&mut out, "summary", self.summary.as_deref());
        for message in &self.queue {
            line(
                &mut out,
                "queued",
                format!("{}  {}", message.id, clip(&message.prompt, 60)),
            );
        }
        if let Some(parent) = &self.parent {
            line(&mut out, "parent", reference(parent));
        }
        if !self.children.is_empty() {
            let children: Vec<_> = self.children.iter().map(reference).collect();
            line(&mut out, "children", children.join(", "));
        }
        out
    }
}

impl Human for SessionList {
    fn human(&self) -> String {
        if self.sessions.is_empty() {
            return "no sessions".into();
        }
        let mut out = String::new();
        for session in &self.sessions {
            let detail = session
                .note
                .as_deref()
                .or(session.summary.as_deref())
                .map(|text| format!("  {}", clip(text, 60)))
                .unwrap_or_default();
            let _ = writeln!(
                out,
                "{:<15}{:<10} {}{}",
                session.state.as_str(),
                session.handle(),
                clip(&session.title, 50),
                detail
            );
        }
        out
    }
}

impl Human for SessionStarted {
    fn human(&self) -> String {
        match &self.turn {
            Some(turn) => format!(
                "started session {} (turn {})",
                reference(&self.session.as_ref()),
                turn.slug.clone().unwrap_or_else(|| turn.id.to_string())
            ),
            None => format!(
                "created session {} without starting it",
                reference(&self.session.as_ref())
            ),
        }
    }
}

impl Human for Forked {
    fn human(&self) -> String {
        let mut out = format!(
            "forked into session {} ({} context)",
            reference(&self.session.as_ref()),
            self.mode
        );
        if let Some(turn) = &self.turn {
            let _ = write!(
                out,
                ", turn {} started",
                turn.slug.clone().unwrap_or_else(|| turn.id.to_string())
            );
        }
        out
    }
}

impl Human for MessageAccepted {
    fn human(&self) -> String {
        match (&self.turn, self.position) {
            (Some(turn), _) => format!(
                "started turn {}",
                turn.slug.clone().unwrap_or_else(|| turn.id.to_string())
            ),
            (None, Some(position)) => {
                format!("queued at position {position}; it runs when the current turn ends")
            }
            (None, None) => "queued".into(),
        }
    }
}

impl Human for WaitOutcome {
    fn human(&self) -> String {
        match (&self.reason, &self.approval) {
            (WaitFor::Input, Some(approval)) => format!(
                "session {} is waiting on approval {} ({})",
                self.session.handle(),
                approval.id,
                approval.tool
            ),
            (WaitFor::Input, None) => {
                format!("session {} is waiting for input", self.session.handle())
            }
            _ => {
                let mut out = format!("session {} is idle", self.session.handle());
                if let Some(summary) = self.session.summary.as_deref() {
                    let _ = write!(out, ": {}", clip(summary, 100));
                }
                out
            }
        }
    }
}

impl Human for Entries {
    fn human(&self) -> String {
        let mut out = String::new();
        for entry in &self.entries {
            let label = match entry.kind {
                EntryKind::User => "user".to_string(),
                EntryKind::Assistant => "assistant".to_string(),
                EntryKind::Error => "error".to_string(),
                EntryKind::Tool => format!(
                    "tool {}{}",
                    entry.tool.as_deref().unwrap_or("?"),
                    entry
                        .status
                        .as_deref()
                        .map(|s| format!(" {s}"))
                        .unwrap_or_default()
                ),
                EntryKind::TurnEnd => {
                    let _ = writeln!(
                        out,
                        "── turn {} {}",
                        entry.turn,
                        entry.status.as_deref().unwrap_or("ended")
                    );
                    continue;
                }
            };
            let _ = writeln!(out, "[{label}] {}", entry.text.trim_end());
        }
        if let Some(cursor) = &self.next_cursor {
            let _ = writeln!(out, "(next cursor {cursor})");
        }
        out
    }
}

impl Human for Transcript {
    fn human(&self) -> String {
        self.markdown.clone()
    }
}

impl Human for Refs {
    fn human(&self) -> String {
        if self.refs.is_empty() {
            return "no references".into();
        }
        let mut out = String::new();
        for r in &self.refs {
            let target = r
                .session
                .as_ref()
                .map(reference)
                .or_else(|| r.label.clone())
                .unwrap_or_default();
            let _ = writeln!(out, "{:<10}{target}", r.kind);
        }
        out
    }
}

impl Human for DiffView {
    fn human(&self) -> String {
        let mut out = format!(
            "{} → {} (base {})\n",
            self.branch,
            self.target_branch,
            &self.base_commit[..self.base_commit.len().min(10)]
        );
        if self.files.is_empty() {
            out.push_str("  no changes\n");
        }
        for file in &self.files {
            let _ = writeln!(
                out,
                "  +{:<5} -{:<5} {}",
                file.additions, file.deletions, file.path
            );
        }
        out
    }
}

impl Human for Merged {
    fn human(&self) -> String {
        format!(
            "merged into {} as {}",
            self.target_branch, self.merge_commit
        )
    }
}

impl Human for Rebased {
    fn human(&self) -> String {
        format!("rebased onto {}", self.onto)
    }
}

impl Human for ApprovalView {
    fn human(&self) -> String {
        let mut out = format!("{}  {} ({})\n", self.id, self.tool, self.status);
        if let Some(session) = &self.session {
            line(&mut out, "session", reference(session));
        }
        if let Some(at) = self.requested_at {
            line(&mut out, "asked", at.format("%Y-%m-%d %H:%M:%S"));
        }
        if let Some(input) = &self.input {
            let pretty = serde_json::to_string_pretty(input).unwrap_or_default();
            out.push_str("  input\n");
            for row in pretty.lines() {
                let _ = writeln!(out, "    {row}");
            }
        }
        out
    }
}

impl Human for ApprovalList {
    fn human(&self) -> String {
        if self.approvals.is_empty() {
            return "no pending approvals".into();
        }
        let mut out = String::new();
        for approval in &self.approvals {
            let session = approval
                .session
                .as_ref()
                .map(SessionRef::handle)
                .unwrap_or_else(|| "-".into());
            let _ = writeln!(out, "{:<38} {:<10} {}", approval.id, session, approval.tool);
        }
        out
    }
}

impl Human for Responded {
    fn human(&self) -> String {
        format!("approval {}", self.status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipping_keeps_one_line_and_marks_the_cut() {
        assert_eq!(clip("a\nb  c", 10), "a b c");
        assert_eq!(clip("abcdefghij", 5), "abcd…");
    }

    #[test]
    fn show_lists_each_queued_message_with_the_id_unqueue_takes() {
        let id = uuid::Uuid::new_v4();
        let view = SessionView {
            id: uuid::Uuid::nil(),
            slug: Some("ab12cd34".into()),
            title: "Fix login".into(),
            project: ProjectView {
                id: uuid::Uuid::nil(),
                slug: None,
                name: "repo".into(),
                path: "/tmp/repo".into(),
            },
            state: SessionState::Running,
            status: "in_progress".into(),
            agent: None,
            branch: None,
            worktree: None,
            note: None,
            summary: None,
            turn: None,
            queue: vec![QueuedMessage {
                id,
                prompt: "Also cover\nlogout".into(),
                created_at: chrono::Utc::now(),
            }],
            parent: None,
            children: Vec::new(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        assert!(view
            .human()
            .contains(&format!("queued   {id}  Also cover logout")));
    }
}
