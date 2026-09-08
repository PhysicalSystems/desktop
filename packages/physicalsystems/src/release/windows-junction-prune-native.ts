// SPDX-License-Identifier: Apache-2.0

/** Compiled after windowsDirectoryProbeDefinition. Only recognized directory
 * links are removed, through the exact no-follow handle whose identity was
 * checked. Regular entries remain for the existing recursive removal. */
export const junctionPruneDefinition = String.raw`
public static class JunctionPruner {
  public sealed class Result { public string status="COMPLETE"; public int entries,linksRemoved; }
  public sealed class TagInfo { public uint attributes,tag; }
  public abstract class MutationOps {
    public abstract TagInfo Tag(IntPtr handle);
    public abstract bool Delete(IntPtr handle);
  }
  public sealed class NativeMutationOps : MutationOps {
    [StructLayout(LayoutKind.Sequential)] struct AttributeTagInfo { public uint attributes,tag; }
    [StructLayout(LayoutKind.Sequential)] struct DispositionInfo { public byte deleteFile; }
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr handle,int kind,out AttributeTagInfo information,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(IntPtr handle,int kind,ref DispositionInfo information,uint size);
    public override TagInfo Tag(IntPtr handle){
      AttributeTagInfo value;if(!GetFileInformationByHandleEx(handle,9,out value,8))throw new Exception();
      return new TagInfo{attributes=value.attributes,tag=value.tag};
    }
    public override bool Delete(IntPtr handle){
      var value=new DispositionInfo{deleteFile=1};return SetFileInformationByHandle(handle,4,ref value,1);
    }
  }
  sealed class Stop : Exception { public readonly string status;public Stop(string value){status=value;} }
  sealed class Identity {
    public readonly ulong dev,ino;public readonly bool directory,reparse;
    public Identity(DirectoryDenialProbe.Info value){
      if(value==null||value.ino==0)throw new Stop("IDENTITY_UNCONFIRMED");
      dev=value.dev;ino=value.ino;directory=(value.attributes&0x10)!=0;reparse=(value.attributes&0x400)!=0;
    }
    public bool Same(Identity other){return dev==other.dev&&ino==other.ino&&directory==other.directory&&reparse==other.reparse;}
  }
  sealed class Lease : IDisposable {
    readonly State state;public IntPtr handle;
    public Lease(State owner,IntPtr value){state=owner;handle=value;}
    public void Dispose(){
      if(handle==IntPtr.Zero)return;var value=handle;handle=IntPtr.Zero;
      try{if(!state.io.Close(value))state.closeFailed=true;}catch{state.closeFailed=true;}
    }
  }
  sealed class Frame {
    public readonly IntPtr parent,handle;public readonly string name;public readonly Identity identity;
    public Frame(IntPtr p,string n,IntPtr h,Identity i){parent=p;name=n;handle=h;identity=i;}
  }
  sealed class State {
    public readonly DirectoryDenialProbe.Ops io;public readonly MutationOps mutations;
    public readonly Result result=new Result();public readonly List<Frame> frames=new List<Frame>();
    public bool closeFailed;
    public State(DirectoryDenialProbe.Ops value,MutationOps mutation){io=value;mutations=mutation;}
    public void Bound(){if(closeFailed)throw new Stop("CLOSE_UNCONFIRMED");if(io.Elapsed>=3000)throw new Stop("BOUNDED");}
    static bool ValidHandle(IntPtr value){return value!=IntPtr.Zero&&value!=new IntPtr(-1);}
    public Lease Open(IntPtr parent,string name,uint access,uint options,uint attributes,string failure){
      Bound();IntPtr handle=IntPtr.Zero;
      try{
        var code=io.Open(parent,name,access,options,attributes,out handle);
        if(code!=0||!ValidHandle(handle))throw new Stop(failure);
        var lease=new Lease(this,handle);handle=IntPtr.Zero;return lease;
      }finally{if(ValidHandle(handle))new Lease(this,handle).Dispose();}
    }
    public Identity Read(IntPtr handle){Bound();return new Identity(io.Metadata(handle));}
    public void Match(IntPtr handle,Identity expected){if(!expected.Same(Read(handle)))throw new Stop("IDENTITY_UNCONFIRMED");}
    public void Rebind(IntPtr parent,string name,Identity expected){
      try{
        using(var current=Open(parent,name,0x00100080,expected.directory?0x00200001u:0x00200040u,0,"IDENTITY_UNCONFIRMED"))Match(current.handle,expected);
      }catch(Stop){throw;}catch{throw new Stop("IDENTITY_UNCONFIRMED");}
      Bound();
    }
    public void Ancestors(){foreach(var frame in frames){Rebind(frame.parent,frame.name,frame.identity);Match(frame.handle,frame.identity);}Bound();}
    public void Absent(IntPtr parent,string name){
      Bound();IntPtr handle=IntPtr.Zero;
      try{
        var code=io.Open(parent,name,0x00100080,0x00200001,0,out handle);
        // The exact single component must be absent; delete-pending, an
        // unreadable entry or a replacement object cannot confirm removal.
        if(code!=0xc0000034||handle!=IntPtr.Zero)throw new Stop("DELETE_UNCONFIRMED");
      }finally{if(ValidHandle(handle))new Lease(this,handle).Dispose();}
      Bound();
    }
    public void Link(IntPtr parent,string name,Identity expected){
      if(!expected.directory||!expected.reparse)throw new Stop("IDENTITY_UNCONFIRMED");
      using(var leaf=Open(parent,name,0x00110080,0x00200001,0,"DELETE_UNCONFIRMED")){
        Match(leaf.handle,expected);Bound();var tag=mutations.Tag(leaf.handle);
        if(tag==null||(tag.attributes&0x410)!=0x410||(tag.tag!=0xa0000003&&tag.tag!=0xa000000c))throw new Stop("IDENTITY_UNCONFIRMED");
        var expectedAttributes=tag.attributes;var expectedTag=tag.tag;
        Ancestors();Rebind(parent,name,expected);Match(leaf.handle,expected);Bound();
        tag=mutations.Tag(leaf.handle);
        if(tag==null||tag.attributes!=expectedAttributes||tag.tag!=expectedTag)throw new Stop("IDENTITY_UNCONFIRMED");
        Bound();
        bool removed;try{removed=mutations.Delete(leaf.handle);}catch{throw new Stop("DELETE_UNCONFIRMED");}
        if(!removed)throw new Stop("DELETE_UNCONFIRMED");
      }
      Bound();Absent(parent,name);result.linksRemoved++;Ancestors();
    }
    public void Walk(IntPtr directory,int depth){
      Bound();
      foreach(var entry in io.Entries(directory)){
        Bound();if(result.entries>=8192||depth>=32)throw new Stop("BOUNDED");
        if(entry==null||!Name(entry.name))throw new Stop("IDENTITY_UNCONFIRMED");
        var name=entry.name;var attributes=entry.attributes;result.entries++;
        var isDirectory=(attributes&0x10)!=0;var isReparse=(attributes&0x400)!=0;Identity identity;
        using(var item=Open(directory,name,0x00100080,isDirectory?0x00200001u:0x00200040u,0,"IDENTITY_UNCONFIRMED")){
          identity=Read(item.handle);
          if(identity.directory!=isDirectory||identity.reparse!=isReparse)throw new Stop("IDENTITY_UNCONFIRMED");
        }
        Bound();
        if(identity.reparse){if(identity.directory)Link(directory,name,identity);continue;}
        if(!identity.directory)continue;
        using(var child=Open(directory,name,0x001200a9,0x00204021,0x80,"UNREADABLE")){
          Match(child.handle,identity);frames.Add(new Frame(directory,name,child.handle,identity));
          try{Walk(child.handle,depth+1);Rebind(directory,name,identity);Match(child.handle,identity);}
          finally{frames.RemoveAt(frames.Count-1);}
        }
        Bound();
      }
      Bound();
    }
  }
  static bool Name(string name){return !String.IsNullOrEmpty(name)&&name!="."&&name!=".."&&name.Length<=255&&name.IndexOfAny(new char[]{'\\','/','\0',':'})<0;}
  public static Result Run(DirectoryDenialProbe.Ops io,MutationOps mutations,string parentPath,string rootName,ulong parentDev,ulong parentIno,ulong rootDev,ulong rootIno){
    var s=new State(io,mutations);
    try{
      if(io==null||mutations==null||String.IsNullOrEmpty(parentPath)||!Name(rootName))throw new Stop("IDENTITY_UNCONFIRMED");
      using(var parent=s.Open(IntPtr.Zero,parentPath,0x00100080,0x00200001,0,"IDENTITY_UNCONFIRMED")){
        var parentIdentity=s.Read(parent.handle);
        if(!parentIdentity.directory||parentIdentity.reparse||parentIdentity.dev!=parentDev||parentIdentity.ino!=parentIno)throw new Stop("IDENTITY_UNCONFIRMED");
        s.frames.Add(new Frame(IntPtr.Zero,parentPath,parent.handle,parentIdentity));
        using(var root=s.Open(parent.handle,rootName,0x00100080,0x00200001,0,"IDENTITY_UNCONFIRMED")){
          var rootIdentity=s.Read(root.handle);
          if(!rootIdentity.directory||rootIdentity.reparse||rootIdentity.dev!=rootDev||rootIdentity.ino!=rootIno)throw new Stop("IDENTITY_UNCONFIRMED");
          using(var directory=s.Open(parent.handle,rootName,0x001200a9,0x00204021,0x80,"UNREADABLE")){
            s.Match(directory.handle,rootIdentity);s.frames.Add(new Frame(parent.handle,rootName,directory.handle,rootIdentity));
            s.Walk(directory.handle,0);s.Ancestors();
          }
        }
      }
      s.Bound();
    }catch(Stop stop){s.result.status=stop.status;}catch{s.result.status="UNREADABLE";}
    if(s.closeFailed)s.result.status="CLOSE_UNCONFIRMED";
    return s.result;
  }
}
`
