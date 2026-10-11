import importlib.util,unittest
from pathlib import Path
from shapely.geometry import box,Polygon
from shapely import STRtree,union_all,coverage_is_valid
spec=importlib.util.spec_from_file_location('builder',Path(__file__).parents[1]/'scripts/build-block-data.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
class GeometryTests(unittest.TestCase):
 def test_city_enclave_and_crossing_parent_boundaries(self):
  block=b.clean(box(0,0,10,10));city=b.clean(Polygon([(3,3),(7,3),(7,7),(3,7)],holes=[[(4,4),(4,6),(6,6),(6,4)]]))
  parent=[b.clean(box(0,0,5,10)),b.clean(box(5,0,10,10))]
  atoms=[]
  for pid,piece in b.partition(block,STRtree(parent),parent,['County A','County B']):
   atoms.extend((pid,cid,geom) for cid,geom in b.partition(piece,STRtree([city]),[city],['city']))
  self.assertAlmostEqual(sum(g.area for _,_,g in atoms),100)
  self.assertAlmostEqual(union_all([g for _,cid,g in atoms if cid]).symmetric_difference(city).area,0)
  self.assertEqual({pid for pid,cid,_ in atoms if cid},{'County A','County B'})
  self.assertAlmostEqual(sum(g.area for _,cid,g in atoms if cid is None),88)
  for i,(_,_,left) in enumerate(atoms):
   for _,_,right in atoms[i+1:]:self.assertAlmostEqual(left.intersection(right).area,0)
  counts=b.allocate(17,[g.area for _,_,g in atoms]);self.assertEqual(sum(counts),17)
 def test_zero_population_and_stable_remainders(self):
  self.assertEqual(b.allocate(0,[0,0]).tolist(),[0,0])
  self.assertEqual(b.allocate(5,[1,1,1]).tolist(),[2,2,1])
 def test_shared_edge_repair_preserves_real_narrow_holes_and_enclaves(self):
  # The real source hole is narrower than the gap-repair tolerance. Background
  # protection must preserve it while closing a synthetic crack elsewhere.
  source=Polygon([(0,0),(10,0),(10,10),(0,10)],holes=[[(2,2),(2.0001,2),(2.0001,8),(2,8)]])
  left=source.intersection(box(0,0,5,10));right=source.intersection(box(5.0001,0,10,10))
  repaired=b.repair_coverage([left,right],[source],gap_width=.002,snapping_distance=1e-7)
  self.assertTrue(coverage_is_valid(repaired))
  self.assertAlmostEqual(union_all(repaired).symmetric_difference(source).area,0,places=8)
  self.assertAlmostEqual(repaired[0].intersection(repaired[1]).area,0)
  self.assertEqual(sum(len(p.interiors) for p in b.polygons(union_all(repaired))),1)
 def test_geometry_repair_preserves_ids_membership_counts_and_votes(self):
  import copy
  source=box(0,0,10,10)
  atoms=[{'id':'left','block':'b','parents':{'CA':'p'},'city':None,'polygons':b.encode_polygons(box(0,0,5,10)),'stats':[3,4],'votes':{'race':[1,2,0]}},
         {'id':'right','block':'b','parents':{'CA':'p'},'city':None,'polygons':b.encode_polygons(box(5+1e-8,0,10,10)),'stats':[5,6],'votes':{'race':[2,1,0]}}]
  original=copy.deepcopy(atoms)
  geoms,_=b.repair_atom_geometry(atoms,[source])
  for before,after in zip(original,atoms):
   self.assertEqual({k:v for k,v in before.items() if k!='polygons'},{k:v for k,v in after.items() if k!='polygons'})
  self.assertAlmostEqual(union_all(geoms).area,100)
 def test_alpine_serialized_fixture_has_matching_edges_and_no_county_voids(self):
  import gzip,json
  root=Path(__file__).parent/'fixtures/block-v1'
  doc=json.loads(gzip.decompress((root/'atoms/alpine.json.gz').read_bytes()))
  geoms=[b.decode_polygons(a['polygons']) for a in doc['atoms']]
  self.assertTrue(coverage_is_valid(geoms))
  self.assertEqual(sum(len(p.interiors) for p in b.polygons(union_all(geoms))),0)
 def test_geometry_repair_refuses_to_hide_populated_fragments(self):
  atom={'id':'populated','polygons':b.encode_polygons(box(0,0,1e-12,1e-12)),'stats':[1],'votes':{}}
  bulk={'id':'bulk','polygons':b.encode_polygons(box(0,0,1,1)),'stats':[0],'votes':{}}
  with self.assertRaisesRegex(RuntimeError,'nonzero atom'):b.repair_atom_geometry([atom,bulk],[box(0,0,1,1)])
 def test_source_alignment_restores_projection_border_slivers(self):
  source=box(0,0,10,10)
  repaired=b.repair_coverage([box(5e-7,0,10+5e-7,10)],[source])
  self.assertAlmostEqual(union_all(repaired).symmetric_difference(source).area,0,places=10)
 def test_finer_noding_preserves_a_real_kern_strip(self):
  # Three actual serialized neighbors: 1e-9 noding absorbs the third polygon
  # despite its substantial area and lack of overlap. Keep its saved-map ID.
  rings=[
   [(-119.0917072,35.4197149),(-119.09223,35.419719),(-119.09223,35.4197352),(-119.0879096,35.4197015),(-119.089197,35.419704),(-119.090779,35.4197077)],
   [(-119.09223,35.4197352),(-119.09223,35.4197353),(-119.083386,35.4197173),(-119.083386,35.419701),(-119.0855795,35.4197182),(-119.0862504,35.4196975),(-119.0862505,35.4196975),(-119.0862506,35.4196975),(-119.086884,35.419699),(-119.087124,35.4197),(-119.0879096,35.4197015),(-119.0879097,35.4197015)],
   [(-119.0864829,35.4196904),(-119.0869032,35.4196774),(-119.089197,35.4196953),(-119.089197,35.419704),(-119.0879096,35.4197015)]]
  original=[Polygon(ring) for ring in rings]
  atoms=[{'id':str(i),'polygons':b.encode_polygons(g),'stats':[i+1],'votes':{'race':[0,1,0]}} for i,g in enumerate(original)]
  geoms,audit=b.repair_atom_geometry(atoms,[union_all(original)])
  self.assertEqual(audit['snappingDistanceDegrees'],1e-10)
  self.assertTrue(coverage_is_valid(geoms))
  for i,geom in enumerate(geoms):
   self.assertFalse(geom.is_empty)
   self.assertEqual(atoms[i]['id'],str(i))
   self.assertEqual(atoms[i]['stats'],[i+1])
   self.assertEqual(atoms[i]['votes'],{'race':[0,1,0]})
   self.assertLess(geom.symmetric_difference(original[i]).area,2e-12)
 def test_matching_coverage_checks_point_touching_holes_without_distortion(self):
  left=Polygon([(-120.3381918,37.7098181),(-120.3381682,37.7095704),(-120.338212,37.709838),(-120.338211,37.709974),(-120.338208,37.710381),(-120.33821,37.710445),(-120.338211,37.710471),(-120.338212,37.710492),(-120.338213,37.710522),(-120.3381949,37.7104964)])
  right=Polygon([(-120.3383509,37.7111554),(-120.3381998,37.7110963),(-120.3381541,37.7104389),(-120.3381949,37.7104964),(-120.338213,37.710522),(-120.338232,37.71108)],holes=[[(-120.3381949,37.7104965),(-120.3381951,37.710535),(-120.3382207,37.7107494),(-120.338213,37.710522)]])
  self.assertTrue(left.relate_pattern(right,'F********'))
  self.assertTrue(b.matching_coverage([left,right]))
  self.assertFalse(b.matching_coverage([box(0,0,1,1),box(.9,0,2,1)]))
  # A midpoint present on only one side remains an invalid shared edge.
  extra_node=Polygon([(1,0),(2,0),(2,1),(1,1),(1,.5)])
  self.assertFalse(b.matching_coverage([box(0,0,1,1),extra_node]))
  self.assertFalse(b.matching_coverage([box(0,0,1,1),box(1,.25,2,.75)]))
 def test_roundoff_void_repair_protects_real_source_holes(self):
  outer=[(0,0),(1e-5,0),(1e-5,1e-5),(0,1e-5)]
  real=[(1e-6,1e-6),(1.1e-6,1e-6),(1.1e-6,1.1e-6),(1e-6,1.1e-6)]
  crack=[(5e-6,5e-6),(5.1e-6,5e-6),(5.1e-6,5.1e-6),(5e-6,5.1e-6)]
  source=Polygon(outer,holes=[real])
  repaired=b.fill_roundoff_voids([Polygon(outer,holes=[real,crack])],source,4e-13)
  self.assertTrue(b.matching_coverage(repaired))
  self.assertEqual(len(repaired[0].interiors),1)
  self.assertEqual(repaired[0].symmetric_difference(source).area,0)
 def test_los_angeles_source_edge_cannot_hide_a_nonzero_strip(self):
  import json
  fixture=json.loads((Path(__file__).parent/'fixtures/geometry/los-angeles-strip.json').read_text())
  geoms=[b.decode_polygons(atom['polygons']) for atom in fixture['atoms']]
  required={i:atom['id'] for i,atom in enumerate(fixture['atoms']) if atom['required']}
  source=b.decode_polygons(fixture['source'])
  # With the exact Census exterior, coarse GEOS noding can absorb a real
  # 115 m² fragment. Retain all nonzero pieces or reject the result for retry.
  try:repaired=b.repair_coverage(geoms,[source],snapping_distance=1e-9,required_ids=required)
  except RuntimeError as error:
   self.assertIn('Geometry repair would hide a nonzero atom:',str(error))
  else:
   for i,atom_id in required.items():self.assertFalse(repaired[i].is_empty,atom_id)
   b.validate_coverage_footprint(repaired,[source])
if __name__=='__main__':unittest.main()
