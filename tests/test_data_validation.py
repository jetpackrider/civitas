import contextlib,gzip,importlib.util,io,json,shutil,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('validator',ROOT/'scripts/validate-block-data.py')
validator=importlib.util.module_from_spec(spec);spec.loader.exec_module(validator)

class DataValidationTests(unittest.TestCase):
 def setUp(self):
  self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
  self.out=Path(self.directory.name)/'data';shutil.copytree(ROOT/'tests/fixtures/block-v1',self.out)
 def rejected(self):
  with contextlib.redirect_stdout(io.StringIO()):
   with self.assertRaises(AssertionError):validator.validate(self.out,fixture=True)
 def test_rejects_wrong_official_block_count(self):
  path=self.out/'source-counts.json';truth=json.loads(path.read_text())
  next(iter(truth['blocks'].values()))[0]+=1;path.write_text(json.dumps(truth));self.rejected()
 def test_rejects_duplicate_atom_membership(self):
  path=self.out/'atoms/alpine.json.gz';doc=json.loads(gzip.decompress(path.read_bytes()))
  members=next(m for m in doc['parents']['CA'].values() if m);members.append(members[0])
  path.write_bytes(gzip.compress(json.dumps(doc).encode()));self.rejected()
 def test_rejects_fractional_atom_votes_before_integer_conversion(self):
  path=self.out/'atoms/alpine.json.gz';doc=json.loads(gzip.decompress(path.read_bytes()))
  doc['atoms'][0]['votes']['president-2024'][0]+=0.5
  path.write_bytes(gzip.compress(json.dumps(doc).encode()));self.rejected()
 def test_rejects_changed_parent_election_total(self):
  path=self.out/'CA/president-2024/votes-alpine.json';doc=json.loads(path.read_text())
  doc['records'][0]['dem']+=1;path.write_text(json.dumps(doc));self.rejected()

if __name__=='__main__':unittest.main()
