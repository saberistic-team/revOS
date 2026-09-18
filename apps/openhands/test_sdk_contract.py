"""Run in the real pinned SDK image; no mocks replace the Conversation factory."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

@unittest.skipUnless(importlib.util.find_spec('openhands') is not None, 'requires pinned OpenHands image')
class ActualSdkContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Production Kelos starts through this adapter entrypoint before build.main.
        if Path('/kelos_entrypoint.sh').exists():
            import runpy
            runpy.run_path('/kelos_entrypoint.sh',run_name='adapter_contract')['normalize_environment']()

    def test_medium_reasoning_model_uses_responses_api(self):
        from openhands.sdk import LLM
        from pydantic import SecretStr
        llm=LLM(model='openai/gpt-6-astra',api_key=SecretStr('test-unused'),reasoning_effort='medium',temperature=None)
        self.assertTrue(llm.uses_responses_api())
        self.assertEqual(llm.reasoning_effort,'medium')

    @unittest.skipUnless(Path('/kelos_entrypoint.sh').exists(), 'requires Kelos adapter image')
    def test_kelos_environment_respects_the_actual_task_uid(self):
        import pwd
        import runpy
        runpy.run_path('/kelos_entrypoint.sh',run_name='adapter_contract')['normalize_environment']()
        self.assertEqual(os.environ['HOME'],pwd.getpwuid(os.getuid()).pw_dir)
        self.assertTrue(all(os.access(p,os.X_OK) for p in os.environ['PATH'].split(os.pathsep)))

    def test_exhausted_checkpoint_constructs_real_conversation_without_model_call(self):
        import build
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            request={'id':str(uuid.uuid4()),'brief':'Synthetic exhausted checkpoint test.','budget':{'chunkTurns':10,'totalTurns':10,'maxSeconds':60,'maxStalledChunks':2,'maxCostUsd':1}}
            (root/'request.json').write_text(json.dumps(request))
            (root/'budget-checkpoint.json').write_text(json.dumps({'allocatedTurns':10,'activeSeconds':0,'chunks':1,'stalledChunks':0}))
            # This is deliberately not a valid credential. Any attempted provider
            # request would fail the test instead of silently using a real key.
            with patch.dict(os.environ,{'OPENAI_API_KEY':'test-unused-no-model-call'}):
                build.main(root)
            result=json.loads((root/'result.json').read_text())
            self.assertEqual(result['state'],'paused')
            self.assertEqual(result['usage']['inputTokens'],0)
            self.assertEqual(result['usage']['outputTokens'],0)
            self.assertTrue((root/'conversation'/request['id'].replace('-','')/'base_state.json').is_file())

if __name__=='__main__':unittest.main()
