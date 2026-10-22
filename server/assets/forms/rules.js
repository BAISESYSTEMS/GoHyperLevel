// Rules part: show-if matching and the way through the screens (logic jumps). Other parts reach it through $.shown and $.nextShown.
(function(){
/*@include logic-rules.js*/
$.shown=pfShown;
$.nextShown=pfNextShown;
// the question (.pf-q) of a field id
$.q=function(i){return $.form.querySelector('[data-id="'+i+'"]')};
})();
