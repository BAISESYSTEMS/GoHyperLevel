// Numbers of a form in the browser: how an answer becomes a number, the score, calculators and the safe formula language.
// The same as evalAst / computeValues in server/services/form-logic.ts (tests/form-logic.test.ts runs both side by side).
// Plain ES5 functions; pfCompute uses pfShown from logic-rules.js.
function pfEval(n,vars){
  function ev(n){
    switch(n.t){
      case'n':return n.v;
      case'v':var x=vars[n.n];return typeof x==='number'&&isFinite(x)?x:0;
      case'u':return n.op==='-'?-ev(n.a):(ev(n.a)?0:1);
      case'q':return ev(n.c)?ev(n.a):ev(n.b);
      case'b':
        if(n.op==='&&')return ev(n.a)&&ev(n.b)?1:0;
        if(n.op==='||')return ev(n.a)||ev(n.b)?1:0;
        var a=ev(n.a),b=ev(n.b);
        switch(n.op){
          case'+':return a+b;case'-':return a-b;case'*':return a*b;
          case'/':return b===0?0:a/b;case'%':return b===0?0:a%b;
          case'==':return a===b?1:0;case'!=':return a!==b?1:0;
          case'<':return a<b?1:0;case'>':return a>b?1:0;case'<=':return a<=b?1:0;
          default:return a>=b?1:0}
      default:
        if(n.fn==='if')return ev(n.args[0])?ev(n.args[1]):ev(n.args[2]);
        var v=[];
        for(var i=0;i<n.args.length;i++)v.push(ev(n.args[i]));
        switch(n.fn){
          case'min':return Math.min.apply(null,v);
          case'max':return Math.max.apply(null,v);
          case'sum':case'avg':var s=0;for(var j=0;j<v.length;j++)s+=v[j];return n.fn==='avg'?s/v.length:s;
          case'round':var k=Math.pow(10,Math.min(Math.max(Math.round(v.length>1?v[1]:0),0),6));return(v[0]<0?-1:v[0]>0?1:0)*Math.round(Math.abs(v[0])*k)/k;
          case'floor':return Math.floor(v[0]);
          case'ceil':return Math.ceil(v[0]);
          case'abs':return Math.abs(v[0]);
          case'sqrt':return v[0]<0?0:Math.sqrt(v[0]);
          default:return Math.pow(v[0],v[1])}}}
  var r=ev(n);
  return isFinite(r)?r:0}
function pfToNum(v){
  var s=String(v===undefined||v===null?'':v).trim();
  if(s==='')return 0;
  var n=Number(s.replace(',','.'));
  return isFinite(n)?n:0}
function pfDays(v){
  var m=/^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(String(v===undefined||v===null?'':v));
  if(!m)return 0;
  var d=(Date.parse(m[2]+'T00:00:00Z')-Date.parse(m[1]+'T00:00:00Z'))/864e5;
  return isFinite(d)&&d>=0?Math.round(d)+1:0}
function pfCompute(sp,raw){
  var vars={},score=0,i,e,vs=sp.v||[];
  for(i=0;i<sp.f.length;i++){
    e=sp.f[i];
    if(e.k==='calc')continue;
    if(!pfShown(e,raw))continue;
    var a=raw[e.n],n=0;
    if(e.k==='num')n=pfToNum(Array.isArray(a)?a[0]:a);
    else if(e.k==='days')n=pfDays(a);
    else if(e.k==='bool')n=(Array.isArray(a)?a.length>0:(a!==undefined&&a!==null&&a!==''&&a!==false))?1:0;
    else if(e.k==='pts'){
      var pk=Array.isArray(a)?a:(a===undefined||a===''||a===null?[]:[a]);
      for(var j=0;j<pk.length;j++){var pp=e.p&&e.p[String(pk[j])];n+=Number(pp)||0}}
    vars[e.vi]=n;vars[e.vn]=n;
    if(e.hp)score+=n;else if(e.w)score+=n*e.w}
  vars.score=score;
  for(i=0;i<sp.f.length;i++){
    e=sp.f[i];
    if(e.k!=='calc'||!pfShown(e,raw))continue;
    var c=pfEval(e.ast,vars);
    vars[e.vi]=c;vars[e.vn]=c}
  for(i=0;i<vs.length;i++)vars[vs[i].n]=pfEval(vs[i].ast,vars);
  return vars}
