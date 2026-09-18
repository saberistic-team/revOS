"""Configuration and resume integration tests with an offline SDK stand-in."""
import json
import os
import pathlib
import sys
import tempfile
import unittest
import uuid
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from build import BUILD_INSTRUCTIONS, REVISION_INSTRUCTIONS, COMPLETION_INSTRUCTIONS, DEFAULT_MAX_ITERATIONS, RESUME_MESSAGE, conversation_input, main, max_iterations, run_with_checkpoints, budget_config


class BuildConfigurationTests(unittest.TestCase):
    def test_checkpoint_continuation_preserves_the_same_conversation_and_files(self):
        self.checkpoint_case('complete', expected='completed', calls=2)

    def test_total_budget_pauses_with_saved_progress(self):
        self.checkpoint_case('budget', expected='paused', calls=1)

    def test_unrelated_errors_are_not_retried_as_turn_limits(self):
        with self.assertRaisesRegex(RuntimeError, 'stopped before completion'):
            self.checkpoint_case('error', expected='paused', calls=1)

    def test_stalled_chunks_pause_instead_of_spending_indefinitely(self):
        self.checkpoint_case('stalled', expected='paused', calls=2)

    def checkpoint_case(self, mode, expected, calls):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); site=root/'site'; site.mkdir(); (site/'existing.txt').write_text('keep me')
            class Conversation:
                def __init__(self):
                    self.state=SimpleNamespace(execution_status=SimpleNamespace(value='running'),events=[])
                    self.calls=0
                def run(self):
                    self.calls+=1
                    if mode=='complete' and self.calls==2:
                        self.state.execution_status.value='finished'
                    else:
                        self.state.events.append(SimpleNamespace(code='OtherError' if mode=='error' else 'MaxIterationsReached'))
                        self.state.execution_status.value='error'
                        if mode!='stalled': (site/'progress.txt').write_text(str(self.calls))
                def send_message(self, message):
                    self.state.execution_status.value='running'
            conversation=Conversation()
            progress=SimpleNamespace(record=lambda *args,**kwargs:None,set_phase=lambda *args:None)
            budget={'chunkTurns':2,'totalTurns':2 if mode=='budget' else 10,'maxSeconds':60,'maxStalledChunks':2}
            result=run_with_checkpoints(conversation,{},root,site,progress,budget)
            self.assertEqual(result['state'],expected)
            self.assertEqual(conversation.calls,calls)
            self.assertEqual((site/'existing.txt').read_text(),'keep me')
            self.assertEqual(json.loads((root/'budget-checkpoint.json').read_text())['allocatedTurns'],calls*2)

    def test_initial_and_resume_instructions_share_completion_rules(self):
        for message in [BUILD_INSTRUCTIONS, REVISION_INSTRUCTIONS, RESUME_MESSAGE]:
            self.assertIn(COMPLETION_INSTRUCTIONS, message)
            self.assertIn('avoid full-file dumps', message)
            self.assertIn('CHECKLIST.md', message)
            self.assertIn('Do not repeat successful checks unless the code they cover changes', message)
            self.assertIn('Check optional browser dependencies at most once', message)
            self.assertIn('Never claim visual verification without actually performing it', message)
            self.assertIn('available relevant checks pass', message)
            self.assertIn('then call finish', message)

    def test_default_and_configured_iteration_allowance_is_finite(self):
        self.assertEqual(DEFAULT_MAX_ITERATIONS, 200)
        self.assertEqual(max_iterations(), 200)
        self.assertEqual(max_iterations('350'), 350)
        for value in ['0', '-1', 'unlimited', 'nan', '1.5', '1001']:
            with self.assertRaises(ValueError):
                max_iterations(value)

    def test_resume_requires_checkpoint_and_does_not_resend_brief(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            identifier = uuid.uuid4()
            request = {'id': str(identifier), 'resume': True, 'brief': 'original-private-brief'}
            with self.assertRaisesRegex(ValueError, 'saved OpenHands conversation is unavailable'):
                conversation_input(request, root)
            state = root / 'conversation' / identifier.hex / 'base_state.json'
            state.parent.mkdir(parents=True)
            state.write_text('{"execution_status":"error"}')
            restored_id, message = conversation_input(request, root)
            self.assertEqual(restored_id, identifier)
            self.assertEqual(message, RESUME_MESSAGE)
            self.assertNotIn('original-private-brief', message)
            self.assertIn('do not rebuild completed files unnecessarily', message)
            self.assertIn('original-private-brief', conversation_input({**request, 'resume': False}, root)[1])
            with self.assertRaisesRegex(ValueError, 'must be a boolean'):
                conversation_input({**request, 'resume': 'true'}, root)

    def test_revision_edits_seeded_source_and_identifies_exact_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            lineage = {'parentBuildId': str(uuid.uuid4()), 'parentCommit': 'a' * 40}
            request = {'id': str(uuid.uuid4()), 'brief': 'Change the selected customer name only', 'lineage': lineage}
            with self.assertRaisesRegex(ValueError, 'were not seeded'):
                conversation_input(request, root)
            (root / 'site').mkdir()
            (root / 'site' / 'index.html').write_text('<html>Existing product</html>')
            _, message = conversation_input(request, root)
            self.assertTrue(message.startswith('Revise the existing site'))
            self.assertIn('Preserve unrelated working features', message)
            self.assertIn(request['brief'], message)
            self.assertIn(lineage['parentCommit'], message)
            self.assertIn(lineage['parentBuildId'], message)
            with self.assertRaisesRegex(ValueError, 'Invalid parent source commit'):
                conversation_input({**request, 'lineage': {**lineage, 'parentCommit': 'main'}}, root)

    def test_runner_reuses_conversation_and_files_with_expanded_budget(self):
        self.run_restored_build(finished=False)

    def test_finished_checkpoint_republishes_without_another_model_turn(self):
        self.run_restored_build(finished=True)

    def test_revision_resume_retains_immutable_lineage(self):
        self.run_restored_build(finished=True, revision=True)

    def run_restored_build(self, finished, revision=False):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            identifier = uuid.uuid4()
            state = root / 'conversation' / identifier.hex / 'base_state.json'
            state.parent.mkdir(parents=True)
            state_snapshot = json.dumps({'execution_status': 'finished' if finished else 'error'})
            state.write_text(state_snapshot)
            site = root / 'site'
            site.mkdir()
            (site / 'existing.css').write_text('body { color: blue; }')
            if finished:
                (site / 'index.html').write_text('<html>Already finished</html>')
            lineage = {'parentBuildId': str(uuid.uuid4()), 'parentCommit': 'b' * 40} if revision else None
            (root / 'request.json').write_text(json.dumps({'id': str(identifier), 'resume': True, 'brief': 'original-private-brief', **({'lineage': lineage} if lineage else {})}))
            recorded = {}

            class FakeConversation:
                def __init__(self, **kwargs):
                    recorded['conversation'] = kwargs
                    self.state = SimpleNamespace(execution_status=SimpleNamespace(value='finished' if finished else 'error'), id=kwargs['conversation_id'])

                def send_message(self, message):
                    recorded['message'] = message

                def run(self):
                    recorded['run_called'] = True
                    (site / 'index.html').write_text('<html>Finished</html>')
                    self.state.execution_status.value = 'finished'

            def configured(name):
                def create(**kwargs):
                    recorded[name] = kwargs
                    return SimpleNamespace(**kwargs)
                return create

            modules = {}
            for name in ['pydantic', 'openhands', 'openhands.sdk', 'openhands.sdk.context', 'openhands.sdk.context.condenser', 'openhands.tools', 'openhands.tools.file_editor', 'openhands.tools.terminal']:
                modules[name] = ModuleType(name)
            modules['pydantic'].SecretStr = lambda value: SimpleNamespace(masked=True)
            modules['openhands.sdk'].Agent = configured('agent')
            modules['openhands.sdk'].LLM = configured('llm')
            modules['openhands.sdk'].Tool = lambda **kwargs: SimpleNamespace(**kwargs)
            modules['openhands.sdk'].Conversation = FakeConversation
            modules['openhands.sdk.context.condenser'].default_condenser = lambda llm: SimpleNamespace(llm=llm)
            modules['openhands.tools.file_editor'].FileEditorTool = SimpleNamespace(name='file_editor')
            modules['openhands.tools.terminal'].TerminalTool = SimpleNamespace(name='terminal')
            with patch.dict(sys.modules, modules), patch.dict(os.environ, {'OPENAI_API_KEY': 'test-unused-key', 'OPENHANDS_MODEL': 'openai/gpt-6-astra', 'OPENHANDS_MAX_ITERATIONS': '250'}):
                main(root)

            self.assertEqual(recorded['conversation']['conversation_id'], identifier)
            self.assertEqual(recorded['conversation']['persistence_dir'], str(root / 'conversation'))
            self.assertEqual(recorded['conversation']['workspace'], str(site))
            self.assertEqual(recorded['conversation']['max_iteration_per_run'], 250)
            self.assertFalse(recorded['conversation']['delete_on_close'])
            if finished:
                self.assertNotIn('message', recorded)
                self.assertNotIn('run_called', recorded)
                self.assertEqual((site / 'index.html').read_text(), '<html>Already finished</html>')
            else:
                self.assertEqual(recorded['message'], RESUME_MESSAGE)
                self.assertTrue(recorded['run_called'])
            self.assertEqual(recorded['llm']['model'], 'openai/gpt-6-astra')
            self.assertEqual(recorded['llm']['reasoning_effort'], 'medium')
            self.assertIs(recorded['agent']['llm'], recorded['agent']['condenser'].llm)
            self.assertEqual((site / 'existing.css').read_text(), 'body { color: blue; }')
            self.assertEqual(state.read_text(), state_snapshot)
            result = json.loads((root / 'result.json').read_text())
            self.assertEqual(result['state'], 'completed')
            self.assertEqual(result.get('lineage'), lineage)
            progress = json.loads((root / 'progress.json').read_text())
            self.assertEqual(progress['maxIterations'], 250)
            self.assertEqual(progress['phase'], 'completed')
            self.assertNotIn('original-private-brief', json.dumps(progress))


if __name__ == '__main__':
    unittest.main()
