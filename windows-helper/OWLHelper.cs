// OWL LAB Windows GUI Helper — x64, .NET Framework 4.8, interactive user session.
// One JSON request on stdin, one JSON response on stdout. No listener, no
// elevation, no credentials and no shell execution. All remote authorization
// belongs to OWL Runtime before this local process is spawned.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

internal static class OWLHelper {
  private const int SM_XVIRTUALSCREEN=76, SM_YVIRTUALSCREEN=77, SM_CXVIRTUALSCREEN=78, SM_CYVIRTUALSCREEN=79;
  private const uint INPUT_MOUSE=0, INPUT_KEYBOARD=1;
  private const uint MOUSE_LEFTDOWN=0x0002, MOUSE_LEFTUP=0x0004;
  private const uint KEYEVENTF_KEYUP=0x0002, KEYEVENTF_UNICODE=0x0004;
  private const int UOI_NAME=2; private const uint DESKTOP_READOBJECTS=0x0001;
  [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT {
    public int dx,dy; public uint mouseData,dwFlags,time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT {
    public ushort wVk,wScan; public uint dwFlags,time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] private struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public MOUSEINPUT mouse;
    [FieldOffset(8)] public KEYBDINPUT key;
  }
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle,System.Text.StringBuilder builder,int maxCount);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);
  [DllImport("user32.dll")] private static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] private static extern uint SendInput(uint count,INPUT[] inputs,int cbSize);
  [DllImport("user32.dll")] private static extern int GetSystemMetrics(int which);
  [DllImport("user32.dll",SetLastError=true)] private static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll",SetLastError=true)] private static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr desktop,int index,System.Text.StringBuilder name,uint length,out uint needed);
  private static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=131072};
  private static bool ReadGranted {get{return Environment.GetEnvironmentVariable("OWL_WIN_GUI_READ_GRANTED")=="true";}}
  private static bool InputGranted {get{return Environment.GetEnvironmentVariable("OWL_WIN_GUI_INPUT_GRANTED")=="true";}}
  private static bool ForegroundGranted {get{return Environment.GetEnvironmentVariable("OWL_WIN_GUI_FOREGROUND_GRANTED")=="true";}}

  [STAThread] static int Main(string[] args) {
    try {
      if(args.Length==1 && args[0]=="--selftest") {Respond(Selftest());return 0;}
      if(args.Length!=1 || args[0]!="--request-stdin")throw new InvalidOperationException("HELPER_PROTOCOL_REQUIRED");
      string line=Console.In.ReadLine();
      if(line==null||line.Length>65536)throw new InvalidOperationException("HELPER_REQUEST_TOO_LARGE");
      var req=Json.Deserialize<Dictionary<string,object>>(line);
      if(req==null||!req.ContainsKey("action"))throw new InvalidOperationException("HELPER_INVALID_REQUEST");
      string action=Str(req,"action");
      bool mutates=action=="click"||action=="click_element"||action=="type"||action=="key"||action=="open_app"||action=="clipboard_write"||action=="clipboard_read"||action=="clipboard_info";
      if(!ReadGranted)throw new InvalidOperationException("WINDOWS_GUI_NOT_AUTHORIZED");
      if(mutates && !InputGranted)throw new InvalidOperationException("WINDOWS_GUI_INPUT_NOT_AUTHORIZED");
      var result=Dispatch(req,action);
      Respond(new Dictionary<string,object>{{"ok",true},{"result",result}});
      return 0;
    }catch(Exception error){
      string code=error is InvalidOperationException ? error.Message : "WINDOWS_GUI_HELPER_FAILED";
      // Never echo raw exception text, target titles, secure values or paths.
      if(code.Length>110||!System.Text.RegularExpressions.Regex.IsMatch(code,@"^[A-Z_0-9]+$")) code="WINDOWS_GUI_HELPER_FAILED";
      Respond(new Dictionary<string,object>{{"ok",false},{"code",code}});
      return 2;
    }
  }
  private static void Respond(object value){Console.Out.WriteLine(Json.Serialize(value));}
  private static string Str(IDictionary<string,object> p,string key,string fallback="") {
    object value; return p.TryGetValue(key,out value)&&value!=null?Convert.ToString(value,CultureInfo.InvariantCulture):fallback;
  }
  private static int Num(IDictionary<string,object> p,string key,int fallback=0) {
    object value;return p.TryGetValue(key,out value)&&value!=null?Convert.ToInt32(value,CultureInfo.InvariantCulture):fallback;
  }
  private static bool Bool(IDictionary<string,object> p,string key,bool fallback=false) {
    object value;return p.TryGetValue(key,out value)&&value!=null?Convert.ToBoolean(value,CultureInfo.InvariantCulture):fallback;
  }
  private static void CheckSession(AutomationElement element){
    if(element==null)throw new InvalidOperationException("WINDOWS_GUI_ELEMENT_NOT_FOUND");
    try {
      int pid=element.Current.ProcessId;
      if(pid<=0)throw new InvalidOperationException("WINDOWS_GUI_WINDOW_NOT_OWNED");
      using(var p=Process.GetProcessById(pid)) {
        if(p.SessionId!=Process.GetCurrentProcess().SessionId)
          throw new InvalidOperationException("WINDOWS_GUI_OTHER_SESSION");
      }
    }catch(InvalidOperationException){throw;}catch{throw new InvalidOperationException("WINDOWS_GUI_WINDOW_NOT_OWNED");}
  }
  private static void RequireDefaultDesktop(){
    IntPtr desktop=OpenInputDesktop(0,false,DESKTOP_READOBJECTS);
    if(desktop==IntPtr.Zero)throw new InvalidOperationException("WINDOWS_SECURE_DESKTOP_BLOCKED");
    try{
      var name=new System.Text.StringBuilder(128);uint needed;
      if(!GetUserObjectInformation(desktop,UOI_NAME,name,256,out needed) || !string.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("WINDOWS_SECURE_DESKTOP_BLOCKED");
    }finally{CloseDesktop(desktop);}
  }
  private static AutomationElement Foreground() {
    RequireDefaultDesktop();
    var hwnd=GetForegroundWindow();
    if(hwnd==IntPtr.Zero)throw new InvalidOperationException("WINDOWS_GUI_FOREGROUND_UNAVAILABLE");
    var e=AutomationElement.FromHandle(hwnd);CheckSession(e);return e;
  }
  private static string ProcessName(AutomationElement e) {
    try{using(var p=Process.GetProcessById(e.Current.ProcessId))return p.ProcessName;}catch{return "Unknown";}
  }
  private static AutomationElement WindowFor(string appName) {
    if(string.IsNullOrWhiteSpace(appName))return Foreground();
    RequireDefaultDesktop();
    var all=AutomationElement.RootElement.FindAll(TreeScope.Children,Condition.TrueCondition);
    foreach(AutomationElement e in all){
      try{
        if(!e.Current.IsOffscreen && (String.Equals(e.Current.Name,appName,StringComparison.OrdinalIgnoreCase) ||
          String.Equals(ProcessName(e),appName,StringComparison.OrdinalIgnoreCase))) {CheckSession(e);return e;}
      }catch(InvalidOperationException){throw;}catch{}
    }
    throw new InvalidOperationException("WINDOWS_GUI_APP_NOT_FOUND");
  }
  private static Dictionary<string,object> Bounds(AutomationElement e) {
    System.Windows.Rect r=e.Current.BoundingRectangle;
    return new Dictionary<string,object>{{"x",r.IsEmpty?null:(object)Math.Round(r.X)},
      {"y",r.IsEmpty?null:(object)Math.Round(r.Y)},
      {"width",r.IsEmpty?null:(object)Math.Round(r.Width)},
      {"height",r.IsEmpty?null:(object)Math.Round(r.Height)}};
  }
  private static object TextBound(string s,int max=200){
    if(s==null)return "";return s.Length>max?s.Substring(0,max):s;
  }
  private static object Metadata(AutomationElement e,int index){
    var b=Bounds(e);
    return new Dictionary<string,object>{{"index",index},{"role",TextBound(e.Current.ControlType.ProgrammaticName)},
      {"name",TextBound(e.Current.Name)},{"description",TextBound(e.Current.HelpText)},
      {"value",SafeValue(e)},{"x",b["x"]},{"y",b["y"]},{"width",b["width"]},{"height",b["height"]}};
  }
  private static string SafeValue(AutomationElement e) {
    try{
      if(e.Current.IsPassword)return "";
      object o;
      if(e.TryGetCurrentPattern(ValuePattern.Pattern,out o))return Convert.ToString(((ValuePattern)o).Current.Value)??"";
    }catch{}
    return "";
  }
  private static IEnumerable<AutomationElement> Walk(AutomationElement e,int limit){
    var queue=new Queue<AutomationElement>();queue.Enqueue(e);int count=0;
    var walker=TreeWalker.ControlViewWalker;
    while(queue.Count>0 && count<limit){
      var current=queue.Dequeue();count++;
      yield return current;
      try{
        for(var child=walker.GetFirstChild(current);child!=null;child=walker.GetNextSibling(child)){
          if(queue.Count+count>=limit*2)break;
          queue.Enqueue(child);
        }
      }catch{}
    }
  }
  private static AutomationElement Find(string query,string appName,int matchIndex){
    if(string.IsNullOrWhiteSpace(query)||query.Length>200||matchIndex<0||matchIndex>99)
      throw new InvalidOperationException("WINDOWS_GUI_INVALID_QUERY");
    var root=WindowFor(appName);
    int match=0;
    foreach(var e in Walk(root,700)){
      try{
        string text=(e.Current.Name??"")+" "+e.Current.AutomationId;
        if(text.IndexOf(query,StringComparison.OrdinalIgnoreCase)<0)continue;
        if(match++==matchIndex){CheckSession(e);return e;}
      }catch(InvalidOperationException){throw;}catch{}
    }
    throw new InvalidOperationException("WINDOWS_GUI_ELEMENT_NOT_FOUND");
  }
  private static string Invoke(AutomationElement e){
    CheckSession(e);
    RequireDefaultDesktop();
    if(e.Current.IsPassword)throw new InvalidOperationException("WINDOWS_GUI_SENSITIVE_CONTROL_BLOCKED");
    if(!e.Current.IsEnabled)throw new InvalidOperationException("WINDOWS_GUI_ELEMENT_DISABLED");
    object pattern;
    if(e.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)) {
      ((InvokePattern)pattern).Invoke();return "uia-invoke";
    }
    if(e.TryGetCurrentPattern(TogglePattern.Pattern,out pattern)) {
      ((TogglePattern)pattern).Toggle();return "uia-toggle";
    }
    if(e.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern)) {
      ((SelectionItemPattern)pattern).Select();return "uia-select";
    }
    throw new InvalidOperationException("WINDOWS_GUI_BACKGROUND_ACTION_UNSUPPORTED");
  }
  private static void EnsureForeground(){
    if(!ForegroundGranted)throw new InvalidOperationException("WINDOWS_GUI_FOREGROUND_TAKEOVER_REQUIRED");
    RequireDefaultDesktop();
    Foreground();
  }
  private static void Inputs(params INPUT[] inputs){
    if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(INPUT)))!=(uint)inputs.Length)
      throw new InvalidOperationException("WINDOWS_GUI_SENDINPUT_REJECTED");
  }
  private static INPUT Mouse(uint flags){return new INPUT{type=INPUT_MOUSE,mouse=new MOUSEINPUT{dwFlags=flags}};}
  private static INPUT Key(ushort vk,ushort scan,uint flags){return new INPUT{type=INPUT_KEYBOARD,key=new KEYBDINPUT{wVk=vk,wScan=scan,dwFlags=flags}};}
  private static ushort VirtualKey(string name){
    switch(name.ToLowerInvariant()){
      case "enter":case "return":return 0x0D;case "tab":return 0x09;
      case "escape":return 0x1B;case "backspace":return 0x08;case "delete":return 0x2E;
      case "left":return 0x25;case "up":return 0x26;case "right":return 0x27;case "down":return 0x28;
      case "pageup":return 0x21;case "pagedown":return 0x22;case "home":return 0x24;case "end":return 0x23;
      case "space":return 0x20;
    }
    if(name.Length==1){
      char c=char.ToUpperInvariant(name[0]);
      if(c>='A'&&c<='Z'||c>='0'&&c<='9')return (ushort)c;
    }
    throw new InvalidOperationException("WINDOWS_GUI_UNSUPPORTED_KEY");
  }
  private static ushort Modifier(string name){
    switch(name.ToLowerInvariant()){
      case "control":return 0x11;case "shift":return 0x10;
      case "option":return 0x12;case "command":return 0x5B;
      default:throw new InvalidOperationException("WINDOWS_GUI_INVALID_MODIFIER");
    }
  }
  private static object Dispatch(Dictionary<string,object> req,string action){
    if(action=="status")return new {platform="win32",backend="win32-uia",readOnly=!InputGranted,
       semanticActions=InputGranted,foregroundInput=ForegroundGranted && InputGranted,
       sessionId=Process.GetCurrentProcess().SessionId};
    if(action=="frontmost_app"){
      var e=Foreground();return new {app=ProcessName(e),windowTitle=TextBound(e.Current.Name),bundleIdentifier=""};
    }
    if(action=="window_bounds"){
      var e=WindowFor(Str(req,"appName"));var b=Bounds(e);b["app"]=ProcessName(e);return b;
    }
    if(action=="ui_tree"){
      var root=WindowFor(Str(req,"appName"));int limit=Math.Max(1,Math.Min(300,Num(req,"maxElements",100)));
      var rows=new List<object>();foreach(var e in Walk(root,limit)){
        try{rows.Add(Metadata(e,rows.Count+1));}catch{}
      }
      return new {app=ProcessName(root),elements=rows,truncated=rows.Count>=limit};
    }
    if(action=="click_element"){
      var e=Find(Str(req,"query"),Str(req,"appName"),Num(req,"matchIndex"));
      var snapshot=Metadata(e,0); // snapshot BEFORE action; controls may disappear.
      var method=Invoke(e);
      return new {clicked=true,method=method,element=snapshot,physicalCursorMoved=false};
    }
    if(action=="click"){
      int x=Num(req,"x"),y=Num(req,"y");
      // Semantic coordinate click first; no physical cursor or focus changes.
      RequireDefaultDesktop();
      var elem=AutomationElement.FromPoint(new System.Windows.Point(x,y));
      try{
        string method=Invoke(elem);
        return new {clicked=true,x=x,y=y,method=method,physicalCursorMoved=false};
      }catch(InvalidOperationException err){
        if(err.Message!="WINDOWS_GUI_BACKGROUND_ACTION_UNSUPPORTED")throw;
      }
      EnsureForeground();
      int vx=GetSystemMetrics(SM_XVIRTUALSCREEN),vy=GetSystemMetrics(SM_YVIRTUALSCREEN);
      int vw=GetSystemMetrics(SM_CXVIRTUALSCREEN),vh=GetSystemMetrics(SM_CYVIRTUALSCREEN);
      if(x<vx||y<vy||x>=vx+vw||y>=vy+vh)throw new InvalidOperationException("WINDOWS_GUI_COORDINATE_OUTSIDE_DESKTOP");
      if(!SetCursorPos(x,y))throw new InvalidOperationException("WINDOWS_GUI_CURSOR_MOVE_FAILED");
      Inputs(Mouse(MOUSE_LEFTDOWN),Mouse(MOUSE_LEFTUP));
      return new {clicked=true,x=x,y=y,method="foreground-sendinput",physicalCursorMoved=true};
    }
    if(action=="type"){
      string value=Str(req,"text");
      if(value.Length>8192)throw new InvalidOperationException("WINDOWS_GUI_TEXT_TOO_LONG");
      var focused=AutomationElement.FocusedElement;
      CheckSession(focused);
      if(focused.Current.IsPassword)
        throw new InvalidOperationException("WINDOWS_GUI_SENSITIVE_CONTROL_BLOCKED");
      object pattern;
      if(focused.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) {
        var p=(ValuePattern)pattern;
        if(!p.Current.IsReadOnly) {
          try { p.SetValue(value); }
          catch {throw new InvalidOperationException("WINDOWS_GUI_ACTION_OUTCOME_UNCERTAIN");}
          return new {typedCharacters=value.Length,method="uia-value-set",clipboardRestored=true,
            physicalCursorMoved=false};
        }
      }
      EnsureForeground();
      var keys=new List<INPUT>();
      foreach(char c in value){keys.Add(Key(0,c,KEYEVENTF_UNICODE));keys.Add(Key(0,c,KEYEVENTF_UNICODE|KEYEVENTF_KEYUP));}
      if(keys.Count>0) Inputs(keys.ToArray());
      return new {typedCharacters=value.Length,method="foreground-sendinput-unicode",
        clipboardRestored=true,focusChanged=false,physicalCursorMoved=false};
    }
    if(action=="key"){
      EnsureForeground();
      string name=Str(req,"key");
      var mods=new List<ushort>();object raw;
      if(req.TryGetValue("modifiers",out raw)&&raw is ArrayList)
        foreach(object m in (ArrayList)raw) mods.Add(Modifier(Convert.ToString(m)));
      var inputs=new List<INPUT>();
      foreach(ushort m in mods) inputs.Add(Key(m,0,0));
      ushort main=VirtualKey(name);
      inputs.Add(Key(main,0,0));inputs.Add(Key(main,0,KEYEVENTF_KEYUP));
      for(int i=mods.Count-1;i>=0;i--) inputs.Add(Key(mods[i],0,KEYEVENTF_KEYUP));
      Inputs(inputs.ToArray());
      return new {key=name,modifiers=mods.Count,method="foreground-sendinput"};
    }
    if(action=="open_app"){
      EnsureForeground();
      var e=WindowFor(Str(req,"appName"));
      var h=(IntPtr)e.Current.NativeWindowHandle;
      if(h==IntPtr.Zero)throw new InvalidOperationException("WINDOWS_GUI_WINDOW_HANDLE_MISSING");
      ShowWindow(h,9);
      if(!SetForegroundWindow(h))throw new InvalidOperationException("WINDOWS_GUI_FOREGROUND_ACTIVATION_DENIED");
      return new {app=ProcessName(e),activated=true,method="foreground-existing-window"};
    }
    if(action=="screenshot"||action=="screenshot_region"){
      RequireDefaultDesktop();
      string p=Str(req,"path");
      if(p.Length<5||p.Length>512||!p.EndsWith(".png",StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("WINDOWS_GUI_SCREENSHOT_PATH_INVALID");
      int x=action=="screenshot"?GetSystemMetrics(SM_XVIRTUALSCREEN):Num(req,"x");
      int y=action=="screenshot"?GetSystemMetrics(SM_YVIRTUALSCREEN):Num(req,"y");
      int w=action=="screenshot"?GetSystemMetrics(SM_CXVIRTUALSCREEN):Num(req,"width");
      int h=action=="screenshot"?GetSystemMetrics(SM_CYVIRTUALSCREEN):Num(req,"height");
      if(w<1||h<1||(long)w*h>50000000)throw new InvalidOperationException("WINDOWS_GUI_SCREENSHOT_SIZE_INVALID");
      using(var bmp=new Bitmap(w,h)){using(var g=Graphics.FromImage(bmp)){
        g.CopyFromScreen(x,y,0,0,new Size(w,h));
      }bmp.Save(p,ImageFormat.Png);}
      return new {path=p,width=w,height=h,x=x,y=y,method="win32-gdi"};
    }
    if(action=="clipboard_read"){
      return new {text=Clipboard.ContainsText()?Clipboard.GetText():""};
    }
    if(action=="clipboard_write"){
      string t=Str(req,"text");if(t.Length>8192)throw new InvalidOperationException("WINDOWS_GUI_TEXT_TOO_LONG");
      Clipboard.SetText(t);return new {writtenCharacters=t.Length};
    }
    if(action=="clipboard_info"){
      return new {types=Clipboard.ContainsText()?new[]{"text/plain"}:new string[0],
        safeTextRestore=Clipboard.ContainsText(),fullFidelitySnapshotAvailable=false};
    }
    throw new InvalidOperationException("WINDOWS_GUI_UNSUPPORTED_ACTION");
  }
  private sealed class NoActivateForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { var value=base.CreateParams; value.ExStyle|=0x08000000; return value; }
    }
  }
  private static object Selftest(){
    var f=new NoActivateForm{Text="OWL LAB GUI selftest",ShowInTaskbar=false,StartPosition=FormStartPosition.Manual,
      Location=new System.Drawing.Point(-20000,-20000),Size=new Size(320,130)};
    var b=new Button{Text="OWL probe button",Location=new System.Drawing.Point(6,6),Size=new Size(150,35)};
    var t=new TextBox{Text="",Location=new System.Drawing.Point(6,50),Width=150};
    int clicks=0;b.Click+=(sender,e)=>clicks++;f.Controls.Add(b);f.Controls.Add(t);
    IntPtr previous=GetForegroundWindow();
    f.CreateControl();b.CreateControl();t.CreateControl();ShowWindow(f.Handle,8);Application.DoEvents();
    try{
      var root=AutomationElement.FromHandle(f.Handle);
      var button=root.FindFirst(TreeScope.Descendants,new PropertyCondition(AutomationElement.NameProperty,"OWL probe button"));
      if(button==null)throw new InvalidOperationException("WINDOWS_GUI_SELFTEST_BUTTON_MISSING");
      object invoke; if(!button.TryGetCurrentPattern(InvokePattern.Pattern,out invoke))
        throw new InvalidOperationException("WINDOWS_GUI_SELFTEST_INVOKE_UNAVAILABLE");
      ((InvokePattern)invoke).Invoke();Application.DoEvents();
      if(clicks!=1)throw new InvalidOperationException("WINDOWS_GUI_SELFTEST_INVOKE_FAILED");
      var field=root.FindFirst(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Edit));
      object val; if(field==null||!field.TryGetCurrentPattern(ValuePattern.Pattern,out val))
        throw new InvalidOperationException("WINDOWS_GUI_SELFTEST_VALUE_UNAVAILABLE");
      ((ValuePattern)val).SetValue("OWL_SELFTEST");
      Application.DoEvents();
      if(t.Text!="OWL_SELFTEST")throw new InvalidOperationException("WINDOWS_GUI_SELFTEST_VALUE_FAILED");
      return new {ok=true,semanticInvoke=true,semanticSetValue=true,focusPreserved=previous==GetForegroundWindow(),foregroundInputExercised=false};
    }finally{f.Close();f.Dispose();}
  }
}
