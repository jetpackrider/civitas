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
 def test_rejects_overlapping_atom_geometry_without_count_changes(self):
  path=self.out/'atoms/alpine.json.gz';doc=json.loads(gzip.decompress(path.read_bytes()))
  visible=[a for a in doc['atoms'] if a['polygons']]
  visible[1]['polygons']=visible[0]['polygons']
  path.write_bytes(gzip.compress(json.dumps(doc).encode()));self.rejected()
 def test_rejects_stale_parent_outline_without_count_changes(self):
  path=self.out/'CA/geometry/precincts-alpine.json';doc=json.loads(path.read_text())
  visible=[r for r in doc['records'] if r['d']]
  visible[1]['d']=visible[0]['d'];path.write_text(json.dumps(doc));self.rejected()
 def test_rejects_false_parent_hole_without_count_changes(self):
  path=self.out/'CA-BG/geometry/precincts-alpine.json';doc=json.loads(path.read_text())
  next(r for r in doc['records'] if r['d'])['d']+=' M 0,0 0,1 1,1 1,0 0,0 Z'
  path.write_text(json.dumps(doc));self.rejected()
 def test_parent_ring_comparison_ignores_order_and_start_but_keeps_winding(self):
  original='M 0,0 2,0 2,2 0,2 0,0 Z M 1,1 1,1.5 1.5,1.5 1.5,1 1,1 Z'
  rotated='M 1.5,1.5 1.5,1 1,1 1,1.5 1.5,1.5 Z M 2,2 0,2 0,0 2,0 2,2 Z'
  self.assertEqual(validator.path_ring_signatures(original),validator.path_ring_signatures(rotated))
  reversed_hole='M 0,0 2,0 2,2 0,2 0,0 Z M 1,1 1.5,1 1.5,1.5 1,1.5 1,1 Z'
  self.assertNotEqual(validator.path_ring_signatures(original),validator.path_ring_signatures(reversed_hole))

if __name__=='__main__':unittest.main()
