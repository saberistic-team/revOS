"""Public build telemetry. Project user-facing text without private SDK content."""

import hashlib
import html
import json
import os
import pathlib
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from collections import deque


PHASE_MESSAGES = {
    "starting": "Starting the OpenHands build environment.",
    "building": "OpenHands is building the site.",
    "validating": "Checking that the generated site has an entry page.",
    "completed": "Site files are ready for publishing.",
    "failed": "The OpenHands build could not finish.",
    "checkpoint": "Saving progress before continuing the coding session.",
    "paused": "Progress is saved. The build needs budget or direction before continuing.",
}
PUBLIC_SUFFIXES = {".html", ".css", ".js", ".mjs", ".json", ".md", ".txt", ".svg",
                   ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2"}
PRIVATE_NAME = re.compile(r"(?:secret|credential|password|token|private[_-]?key|api[_-]?key|sk-[a-z0-9])", re.I)
FILE_COMMANDS = {"view", "create", "str_replace", "insert", "undo_edit"}
MAX_MESSAGES = 50
MAX_MESSAGE_CHARACTERS = 4000
MAX_MESSAGES_BYTES = 50_000
PRIVATE_TAG = re.compile(r'<\s*/?\s*(?:think|thinking|analysis|reasoning|scratchpad|chain_of_thought|chain-of-thought)\b', re.I)
FALLBACK_ACTION_SUMMARY = re.compile(r'^\s*[\w.-]+\s*:\s*[\[{]')


def secret_values():
    return sorted({value for key, value in os.environ.items()
                   if value and re.search(r'(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)', key, re.I)}, key=len, reverse=True)


def public_text(value, secrets=None):
    """Return bounded user-facing text and a truncation flag, never hidden blocks."""
    if not isinstance(value, str):
        return '', False
    if len(value) > 100_000:
        return '', True
    truncated = False
    text = value
    for _ in range(3):
        decoded = html.unescape(text)
        if decoded == text:
            break
        text = decoded
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]', '', text)
    # A message containing explicit private-reasoning tags is omitted whole.
    # This also handles nested, mismatched, and unterminated blocks safely.
    if PRIVATE_TAG.search(text):
        return '', False
    for secret in secret_values() if secrets is None else secrets:
        if secret:
            text = text.replace(secret, '[redacted]')
    text = re.sub(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)', '[redacted]', text)
    text = re.sub(r'\b(?:sk-|gh[pousr]_|github_pat_|glpat-|gitea_|forgejo_|xox[baprs]-)[A-Za-z0-9_-]{10,}\b', '[redacted]', text)
    text = re.sub(r'\bAKIA[A-Z0-9]{16}\b', '[redacted]', text)
    text = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', '[redacted]', text)
    text = re.sub(r'(?i)\b(Bearer|Basic)\s+[^\s\)\]>]+', r'\1 [redacted]', text)
    text = re.sub(r'(?i)\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*)[\'"]?[^\s\'",;]+[\'"]?', r'\1[redacted]', text)
    text = re.sub(r'(https?://)[^/@\s]+:[^/@\s]+@', r'\1[redacted]@', text)
    text = text.strip()
    if len(text) > MAX_MESSAGE_CHARACTERS:
        text = text[:MAX_MESSAGE_CHARACTERS - 1] + '…'
        truncated = True
    return text, truncated


def public_event_messages(event, secrets=None):
    """Only fields explicitly intended for users; never use __str__/visualize."""
    event_type = type(event).__name__
    candidates = []
    if event_type == 'ActionEvent' and field(event, 'source') == 'agent':
        summary = field(event, 'summary')
        # The SDK synthesizes fallback summaries from raw tool JSON. Those are
        # tool arguments, not public explainability, and must be omitted whole.
        if isinstance(summary, str) and len(summary) <= 600 and not FALLBACK_ACTION_SUMMARY.match(summary):
            candidates.append(('summary', 'summary', summary))
        if field(event, 'tool_name') == 'finish':
            candidates.append(('finish', 'message', field(field(event, 'action'), 'message')))
    elif event_type == 'MessageEvent' and field(event, 'source') == 'agent':
        message = field(event, 'llm_message')
        if field(message, 'role') == 'assistant':
            content = field(message, 'content')
            if isinstance(content, (list, tuple)):
                parts = [field(item, 'text') for item in content
                         if field(item, 'type') == 'text' and isinstance(field(item, 'text'), str)]
                candidates.append(('message', 'message', '\n'.join(parts)))
    result, truncated = [], False
    raw_timestamp = field(event, 'timestamp')
    try:
        parsed = datetime.fromisoformat(raw_timestamp.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        at = parsed.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    except (AttributeError, TypeError, ValueError):
        at = now()
    for suffix, kind, value in candidates:
        text, shortened = public_text(value, secrets)
        truncated = truncated or shortened
        if not text:
            continue
        if suffix == 'summary' and FALLBACK_ACTION_SUMMARY.match(text):
            continue
        identifier = field(event, 'id')
        if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', identifier):
            identifier = 'public-' + hashlib.sha256((event_type + ':' + suffix + ':' + text).encode()).hexdigest()[:24]
        result.append({'id': identifier + ':' + suffix, 'at': at, 'role': 'assistant', 'text': text, 'kind': kind})
    return result, truncated


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def field(value, name, default=None):
    return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)


def public_path(value, site):
    """Only expose ordinary site-relative names, never hidden files or symlinks."""
    if not isinstance(value, str) or len(value) > 240 or not re.fullmatch(r"[A-Za-z0-9_./ -]+", value):
        return None
    path = pathlib.Path(value)
    try:
        relative = path.relative_to(site) if path.is_absolute() else path
        if not relative.parts or any(part.startswith(".") for part in relative.parts):
            return None
        if PRIVATE_NAME.search(str(relative)) or relative.suffix.lower() not in PUBLIC_SUFFIXES:
            return None
        target = site
        for part in relative.parts:
            target = target / part
            if target.is_symlink():
                return None
        target.resolve().relative_to(site.resolve())
        return relative.as_posix()
    except (OSError, ValueError, RuntimeError):
        return None


def event_summary(event, site):
    """Allowlisted metadata only, including when SDK versions add new fields."""
    event_type = type(event).__name__
    tool = field(event, "tool_name")
    if event_type in {"AgentErrorEvent", "ConversationErrorEvent"}:
        code = field(event, "code")
        if event_type == "ConversationErrorEvent" and code in {"MaxIterationsReached", "MaxBudgetReached"}:
            message = "OpenHands reached its coding-turn limit before finishing." if code == "MaxIterationsReached" else "OpenHands reached its configured budget before finishing."
            return {"kind": "error", "eventType": event_type, "code": code, "message": message}
        return {"eventType": event_type, "kind": "error", "message": "OpenHands reported an execution error."}
    if event_type not in {"ActionEvent", "ObservationEvent"}:
        return None
    action = event_type == "ActionEvent"
    detail = field(event, "action" if action else "observation")
    metadata = {"eventType": event_type}
    if tool == "file_editor":
        metadata["toolName"] = tool
        name = public_path(field(detail, "path"), site)
        if name:
            metadata["filePath"] = name
        target = name or "a workspace file"
        command = field(detail, "command")
        if command in FILE_COMMANDS:
            metadata["commandKind"] = command
        if action:
            verb = {"view": "Reading", "create": "Creating", "str_replace": "Editing",
                    "insert": "Editing", "undo_edit": "Restoring"}.get(command, "Opening")
            return {**metadata, "kind": "tool", "message": f"{verb} {target}."}
        if field(detail, "is_error") is True:
            return {**metadata, "kind": "error", "isError": True, "message": "The file operation needs another attempt."}
        verb = "Read" if command == "view" else "Updated"
        return {**metadata, "kind": "file", "message": f"{verb} {target}."}
    if tool == "terminal":
        metadata["toolName"] = tool
        if action:
            return {**metadata, "kind": "tool", "message": "Running a workspace command."}
        exit_code = field(detail, "exit_code")
        if exit_code is None:
            exit_code = field(field(detail, "metadata"), "exit_code")
        if type(exit_code) is int and -1 <= exit_code <= 255:
            metadata["exitCode"] = exit_code
        if exit_code == -1:
            return {**metadata, "kind": "tool", "message": "The workspace command is still running."}
        if field(detail, "is_error") is True or (type(exit_code) is int and exit_code != 0):
            return {**metadata, "kind": "error", "isError": True, "message": "The workspace command reported an error."}
        return {**metadata, "kind": "tool", "message": "The workspace command finished."}
    if tool == "finish" and action:
        return {**metadata, "toolName": tool, "kind": "status", "message": "OpenHands is wrapping up the build."}
    # In particular, never expose think tools, assistant text, or unknown tool names.
    return None


class BuildProgress:
    """Atomic, bounded status with separate heartbeat and actual event timestamps."""

    def __init__(self, root, site, heartbeat_seconds=10):
        self.root = pathlib.Path(root)
        self.site = pathlib.Path(site)
        self.phase = "starting"
        self.message = PHASE_MESSAGES[self.phase]
        self.events = []
        self.messages = []
        self.messages_truncated = False
        self.message_ids = deque(maxlen=5000)
        self.last_event_at = None
        self.max_iterations = None
        self.lock = threading.RLock()
        self.stopped = threading.Event()
        self.heartbeat_seconds = heartbeat_seconds
        self.thread = None
        self.set_phase("starting")

    def start(self):
        self.thread = threading.Thread(target=self._heartbeat, daemon=True)
        self.thread.start()

    def stop(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=2)

    def _heartbeat(self):
        while not self.stopped.wait(self.heartbeat_seconds):
            self.refresh()

    def files(self):
        files = []
        if self.site.is_symlink():
            return files
        try:
            for visited, (directory, directories, names) in enumerate(os.walk(self.site, followlinks=False)):
                if visited >= 160:
                    break
                directories[:] = sorted(d for d in directories if not d.startswith(".") and not (pathlib.Path(directory) / d).is_symlink())[:80]
                for name in sorted(names):
                    path = pathlib.Path(directory) / name
                    relative = public_path(str(path), self.site)
                    if not relative:
                        continue
                    try:
                        if path.is_file():
                            files.append({"path": relative, "size": path.stat().st_size})
                    except OSError:
                        continue
                    if len(files) >= 80:
                        return files
        except OSError:
            pass
        return files

    def refresh(self):
        with self.lock:
            payload = {"phase": self.phase, "message": self.message, "updatedAt": now(),
                       "lastEventAt": self.last_event_at, "events": list(self.events), "files": self.files(),
                       "messages": list(self.messages), "messagesTruncated": self.messages_truncated}
            if self.max_iterations is not None:
                payload["maxIterations"] = self.max_iterations
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", dir=self.root, prefix=".progress-", suffix=".tmp", delete=False) as handle:
                    temporary = handle.name
                    json.dump(payload, handle)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.root / "progress.json")
            except OSError:
                # Telemetry must not turn an otherwise successful build into a failure.
                pass
            finally:
                if temporary:
                    try:
                        os.unlink(temporary)
                    except OSError:
                        pass

    def record(self, kind, message, **metadata):
        with self.lock:
            at = now()
            self.events.append({"id": str(uuid.uuid4()), "at": at, "kind": kind, "message": message, **metadata})
            self.events = self.events[-40:]
            self.last_event_at = at
            self.message = message
            self.refresh()

    def set_phase(self, phase):
        with self.lock:
            self.phase = phase
            self.record("status", PHASE_MESSAGES[phase], phase=phase)

    def set_max_iterations(self, value):
        with self.lock:
            self.max_iterations = value
            self.refresh()

    def on_event(self, event):
        with self.lock:
            messages, shortened = public_event_messages(event)
            self.messages_truncated = self.messages_truncated or shortened
            for message in messages:
                if message['id'] in self.message_ids:
                    continue
                self.message_ids.append(message['id'])
                self.messages.append(message)
                self.last_event_at = now()
            while len(self.messages) > MAX_MESSAGES or sum(len(item['text'].encode('utf8')) for item in self.messages) > MAX_MESSAGES_BYTES:
                self.messages.pop(0)
                self.messages_truncated = True
            summary = event_summary(event, self.site)
            if summary:
                self.record(**summary)
            elif messages or shortened:
                self.refresh()
