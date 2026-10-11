import copy,gzip,hashlib,importlib.util,json,unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('repair',ROOT/'scripts/repair-block-geometry.py')
repair=importlib.util.module_from_spec(spec);spec.loader.exec_module(repair)

class RepairIntegrityTests(unittest.TestCase):
 def test_streamed_digest_matches_existing_county_audit_format(self):
  atoms=json.loads(gzip.decompress((ROOT/'tests/fixtures/block-v1/atoms/alpine.json.gz').read_bytes()))['atoms']
  original=json.dumps([{k:v for k,v in atom.items() if k!='polygons'} for atom in atoms],sort_keys=True,separators=(',',':')).encode()
  self.assertEqual(repair.numeric_digest(atoms),hashlib.sha256(original).hexdigest())
  self.assertEqual(repair.numeric_digest([]),hashlib.sha256(b'[]').hexdigest())
 def test_digest_excludes_geometry_but_detects_changed_assignments_and_votes(self):
  original=[{'id':'block:piece','parents':{'CA':'County|1'},'city':None,'polygons':[],'stats':[3],'votes':{'race':[1,2,0]}}]
  reference=repair.numeric_digest(original)
  changed=copy.deepcopy(original);changed[0]['polygons']=[[[[0,0],[1,0],[1,1],[0,0]]]]
  self.assertEqual(repair.numeric_digest(changed),reference)
  for field,value in [('parents',{'CA':'County|2'}),('votes',{'race':[2,1,0]}),('stats',[4]),('id','block:other'),('city','city')]:
   changed=copy.deepcopy(original);changed[0][field]=value
   self.assertNotEqual(repair.numeric_digest(changed),reference,field)

if __name__=='__main__':unittest.main()
