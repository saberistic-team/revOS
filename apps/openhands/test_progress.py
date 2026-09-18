"""Run with: python3 -m unittest discover -s apps/openhands -p 'test_*.py'."""
import json
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from progress import BuildProgress, event_summary, public_event_messages, public_path, public_text


def event(kind, **fields):
    return type(kind, (), fields)()


class BuildProgressTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.site = self.root / 'site'
        self.site.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def test_allowlisted_events_never_copy_sensitive_payloads(self):
        detail = SimpleNamespace(command='create', path=str(self.site / 'index.html'), file_text='secret-content')
        item = event('ActionEvent', tool_name='file_editor', action=detail, thought='secret-thought', summary='secret-summary', reasoning_content='secret-reasoning')
        summary = event_summary(item, self.site)
        self.assertEqual(summary['message'], 'Creating index.html.')
        self.assertEqual(summary['filePath'], 'index.html')
        self.assertEqual(summary['commandKind'], 'create')
        self.assertNotIn('secret', json.dumps(summary))
        terminal = event('ActionEvent', tool_name='terminal', action=SimpleNamespace(command='echo secret-command'))
        self.assertEqual(event_summary(terminal, self.site)['message'], 'Running a workspace command.')
        response = event('ObservationEvent', tool_name='terminal', observation=SimpleNamespace(exit_code=0, text='secret-output'))
        self.assertEqual(event_summary(response, self.site)['message'], 'The workspace command finished.')
        for kind in ['MessageEvent', 'SystemPromptEvent', 'StreamingDeltaEvent', 'LLMCompletionLogEvent']:
            self.assertIsNone(event_summary(event(kind, text='secret'), self.site))
        self.assertIsNone(event_summary(event('ActionEvent', tool_name='think', action={'thought': 'secret'}), self.site))
        self.assertIsNone(event_summary(event('ActionEvent', tool_name='secret-tool', action={}), self.site))

    def test_paths_do_not_escape_or_expose_hidden_secret_files(self):
        (self.site / 'link').symlink_to(self.root, target_is_directory=True)
        for name in ['../request.json', '.env', 'secrets.json', 'api-key.txt', 'auth/token.json', 'bad\nfile.html', 'link/request.json', '/etc/passwd', 'a/../index.html']:
            self.assertIsNone(public_path(name, self.site), name)
        self.assertEqual(public_path(str(self.site / 'assets' / 'app.js'), self.site), 'assets/app.js')

    def test_terminal_pending_and_failure_status_dont_claim_success(self):
        pending = event('ObservationEvent', tool_name='terminal', observation={'metadata': {'exit_code': -1}})
        failed = event('ObservationEvent', tool_name='terminal', observation={'exit_code': 1})
        self.assertEqual(event_summary(pending, self.site)['message'], 'The workspace command is still running.')
        self.assertEqual(event_summary(pending, self.site)['exitCode'], -1)
        self.assertEqual(event_summary(failed, self.site)['kind'], 'error')

    def test_atomic_bounded_projection_and_heartbeat_preserves_event_time(self):
        (self.site / 'index.html').write_text('hello')
        (self.site / '.env').write_text('secret')
        (self.site / 'secrets.json').write_text('secret')
        progress = BuildProgress(self.root, self.site)
        progress.set_phase('building')
        for _ in range(45):
            progress.on_event(event('ActionEvent', tool_name='terminal', action={'command': 'secret-command'}))
        first = json.loads((self.root / 'progress.json').read_text())
        progress.refresh()
        second = json.loads((self.root / 'progress.json').read_text())
        self.assertEqual(first['events'], second['events'])
        self.assertEqual(first['lastEventAt'], second['lastEventAt'])
        self.assertEqual(len(second['events']), 40)
        self.assertEqual(second['phase'], 'building')
        self.assertEqual(second['files'], [{'path': 'index.html', 'size': 5}])
        self.assertNotIn('secret', json.dumps(second))
        self.assertEqual(list(self.root.glob('.progress-*.tmp')), [])
        progress.set_phase('completed')
        self.assertEqual(json.loads((self.root / 'progress.json').read_text())['phase'], 'completed')

    def test_public_messages_only_use_intended_assistant_fields(self):
        item = event('ActionEvent', id='action-1', source='agent', timestamp='2026-09-17T12:00:00',
                     tool_name='file_editor', summary='Updating the customer name while preserving the layout.',
                     thought='PRIVATE_THOUGHT', reasoning_content='PRIVATE_REASONING', thinking_blocks=['PRIVATE_BLOCK'],
                     responses_reasoning_item={'text': 'PRIVATE_RESPONSE'}, action={'file_text': 'PRIVATE_FILE', 'command': 'create'})
        messages, truncated = public_event_messages(item, [])
        self.assertFalse(truncated)
        self.assertEqual(messages, [{'id': 'action-1:summary', 'at': '2026-09-17T12:00:00.000Z', 'role': 'assistant',
                                    'text': 'Updating the customer name while preserving the layout.', 'kind': 'summary'}])
        final = event('ActionEvent', id='finish-1', source='agent', timestamp='2026-09-17T12:01:00Z', tool_name='finish',
                      action={'message': 'The revision is ready. Browser validation was unavailable.'}, thought='PRIVATE')
        self.assertEqual(public_event_messages(final, [])[0][0]['id'], 'finish-1:finish')
        chat = event('MessageEvent', id='message-1', source='agent', timestamp='2026-09-17T12:01:00Z',
                     llm_message={'role': 'assistant', 'content': [{'type': 'text', 'text': 'The checks passed.'},
                                                                {'type': 'image', 'text': 'PRIVATE_IMAGE'}],
                                  'reasoning_content': 'PRIVATE_REASONING'}, extended_content=[{'text': 'PRIVATE_EXTENSION'}])
        self.assertEqual(public_event_messages(chat, [])[0][0]['text'], 'The checks passed.')
        for source in ['user', 'system', 'environment']:
            self.assertEqual(public_event_messages(event('MessageEvent', source=source, llm_message={'role': 'assistant', 'content': [{'type': 'text', 'text': 'PRIVATE'}]}), [])[0], [])
        for kind in ['ObservationEvent', 'AgentErrorEvent', 'SystemPromptEvent']:
            self.assertEqual(public_event_messages(event(kind, source='agent', text='PRIVATE', content='PRIVATE', summary='PRIVATE'), [])[0], [])
        self.assertEqual(public_event_messages(event('MessageEvent', source='agent', llm_message={'role': 'user', 'content': [{'type': 'text', 'text': 'PRIVATE'}]}), [])[0], [])
        self.assertNotIn('PRIVATE', json.dumps(messages))

    def test_sdk_raw_argument_fallback_is_never_published_as_summary(self):
        for summary in ['terminal: {"command":"PRIVATE_COMMAND"}', 'file_editor: {"file_text":"PRIVATE_FILE"}',
                        'terminal: ["PRIVATE"]', '\x1b[32mterminal: {"command":"PRIVATE"}', 'x' * 601]:
            messages, _ = public_event_messages(event('ActionEvent', source='agent', tool_name='terminal', summary=summary), [])
            self.assertEqual(messages, [])
        self.assertEqual(public_event_messages(event('ActionEvent', source='agent', tool_name='terminal', thought='PRIVATE'), [])[0], [])

    def test_public_text_redacts_secrets_and_omits_reasoning_tags(self):
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'exact-private-value'}):
            text, _ = public_text('Done exact-private-value sk-proj-abcdefghijklmnop Bearer abcdefghijk password="hiddenpass" https://user:pass@example.test\x00\x1b[31m')
        for private in ['exact-private-value', 'sk-proj-abcdefghijklmnop', 'abcdefghijk', 'hiddenpass', 'user:pass', '\x00', '\x1b']:
            self.assertNotIn(private, text)
        self.assertIn('[redacted]', text)
        for private in ['<think>PRIVATE</think>Public', '<analysis><think>PRIVATE</think>MORE</analysis>',
                        '<reasoning>PRIVATE', '&lt;scratchpad&gt;PRIVATE', '<thinking PRIVATE',
                        '<analysis>PRIVATE</think>PRIVATE</analysis>', '<th\u200bink>PRIVATE',
                        '&amp;lt;analysis&amp;gt;PRIVATE&amp;lt;/analysis&amp;gt;',
                        '&amp;amp;lt;scratchpad&amp;amp;gt;PRIVATE',
                        '< scrat\x00ch\u200bpad >PRIVATE</scratchpad>']:
            self.assertEqual(public_text(private, [])[0], '')
        text, truncated = public_text('Public ' * 1000, [])
        self.assertTrue(truncated)
        self.assertEqual(len(text), 4000)

    def test_chat_is_bounded_deduplicated_and_has_stable_missing_id_fallback(self):
        progress = BuildProgress(self.root, self.site)
        for i in range(60):
            progress.on_event(event('ActionEvent', id='summary-' + str(i), source='agent', summary='Checking file ' + str(i)))
        payload = json.loads((self.root / 'progress.json').read_text())
        self.assertEqual(len(payload['messages']), 50)
        self.assertTrue(payload['messagesTruncated'])
        repeated = event('MessageEvent', source='agent', llm_message={'role': 'assistant', 'content': [{'type': 'text', 'text': 'Ready to review.'}]})
        one, _ = public_event_messages(repeated, [])
        two, _ = public_event_messages(repeated, [])
        self.assertEqual(one[0]['id'], two[0]['id'])
        progress.on_event(repeated)
        progress.on_event(repeated)
        self.assertEqual(sum(m['text'] == 'Ready to review.' for m in progress.messages), 1)
        for i in range(20):
            progress.on_event(event('MessageEvent', id='long-' + str(i), source='agent', llm_message={'role': 'assistant', 'content': [{'type': 'text', 'text': '字' * 5000}]}))
        self.assertLessEqual(sum(len(m['text'].encode('utf8')) for m in progress.messages), 50_000)
        self.assertTrue(progress.messages_truncated)


if __name__ == '__main__':
    unittest.main()
