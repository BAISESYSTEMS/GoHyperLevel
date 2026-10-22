// File upload: a chosen file (up to 5 MB) is sent along with the answers as a data URL.
(function(){
$.file=function(f){
  return new Promise(function(ok,no){
    if(f.size>5242880)return no(new Error(f.name+' ist größer als 5 MB'));
    var r=new FileReader();
    r.onload=function(){ok({name:f.name,type:f.type,data:r.result})};
    r.onerror=no;
    r.readAsDataURL(f)})}})();
