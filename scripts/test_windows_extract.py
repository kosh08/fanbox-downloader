
import importlib.util,sys,unittest,tempfile,zipfile,json,struct,stat
from pathlib import Path
import windows_extract as helper
class Tests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.zip=self.root/'test.zip'
 def tearDown(self):self.temp.cleanup()
 def make(self,entries):
  with zipfile.ZipFile(self.zip,'w',zipfile.ZIP_DEFLATED) as z:
   for name,content in entries:z.writestr(name,content)
  s=self.zip.stat();return {'archive':str(self.zip),'size':s.st_size,'modifiedNs':s.st_mtime_ns}
 def test_preserves_app_tree_and_names_without_execution(self):
  item=self.make([('日本語Unity/Application.exe','not executable'),('日本語Unity/Runtime/plugin.dll','library data'),('日本語Unity/data.json','{}')]);result=helper.extract_one(self.root,item);dest=Path(result['destination'])
  self.assertEqual(result['status'],'ok');self.assertEqual((dest/'日本語Unity/Runtime/plugin.dll').read_text(),'library data');self.assertTrue(self.zip.exists());self.assertEqual(helper.extract_one(self.root,item)['status'],'skip')
 def test_dry_run_never_writes_to_the_work_folder(self):
  item=self.make([('x.txt','data')]);before=set(self.root.iterdir());result=helper.extract_one(self.root,item,True);self.assertEqual(result['status'],'ready');self.assertEqual(before,set(self.root.iterdir()))
 def test_existing_destination_is_never_overwritten(self):
  item=self.make([('x.txt','new')]);dest=self.root/'test_展開';dest.mkdir();(dest/'x.txt').write_text('old');self.assertEqual(helper.extract_one(self.root,item)['status'],'skip');self.assertEqual((dest/'x.txt').read_text(),'old')
 def test_rejects_traversal_absolute_names_and_windows_collisions(self):
  for names in [['../escape.txt'],['/absolute.txt'],['C:/escape.txt'],['file.txt','FILE.TXT'],['CON.txt'],['dir','dir/file.txt']]:
   with self.subTest(names=names):
    item=self.make([(n,'data')for n in names]);self.assertRaises(ValueError,helper.extract_one,self.root,item);self.assertFalse((self.root/'test_展開').exists())
 def test_rejects_links(self):
  with zipfile.ZipFile(self.zip,'w')as z:
   e=zipfile.ZipInfo('link');e.create_system=3;e.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(e,'elsewhere')
  s=self.zip.stat();item={'archive':str(self.zip),'size':s.st_size,'modifiedNs':s.st_mtime_ns};self.assertRaises(ValueError,helper.extract_one,self.root,item)
 def test_refuses_changed_archive(self):
  item=self.make([('x.txt','data')]);self.zip.write_bytes(b'changed');self.assertRaises(ValueError,helper.extract_one,self.root,item)
 def test_crc_failure_removes_only_own_stage_and_retains_source(self):
  with zipfile.ZipFile(self.zip,'w',zipfile.ZIP_STORED)as z:z.writestr('x.txt','original-content')
  data=bytearray(self.zip.read_bytes());at=data.index(b'original-content');data[at]^=1;self.zip.write_bytes(data);s=self.zip.stat();item={'archive':str(self.zip),'size':s.st_size,'modifiedNs':s.st_mtime_ns}
  self.assertRaises(RuntimeError,helper.extract_one,self.root,item);self.assertTrue(self.zip.exists());self.assertFalse((self.root/'test_展開').exists());self.assertFalse(list(self.root.glob('.fanbox-unzip-*')))
 def test_cleanup_refuses_any_unrelated_directory(self):
  other=self.root/'keep';other.mkdir();(other/'file').write_text('preserve');self.assertRaises(ValueError,helper.cleanup_stage,other,self.root,self.root);self.assertTrue((other/'file').exists())
 def test_archive_outside_manifest_root_is_refused(self):
  item=self.make([('x.txt','data')]);inner=self.root/'inner';inner.mkdir();self.assertRaises(ValueError,helper.extract_one,inner,item)
if __name__=='__main__':unittest.main()
