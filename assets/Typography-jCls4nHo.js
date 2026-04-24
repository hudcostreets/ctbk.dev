import{d as M,g as R,r as T,e as j,j as b,s as k,c as D,f as p,h as B,m as $,aw as W,ax as N}from"./index-D3XAu3MP.js";import{c as U,i as A}from"./createSimplePaletteValueFilter-IxjkwGsM.js";function O(e){return M("MuiCircularProgress",e)}R("MuiCircularProgress",["root","determinate","indeterminate","colorPrimary","colorSecondary","svg","circle","circleDeterminate","circleIndeterminate","circleDisableShrink"]);const i=44,S=N`
  0% {
    transform: rotate(0deg);
  }

  100% {
    transform: rotate(360deg);
  }
`,P=N`
  0% {
    stroke-dasharray: 1px, 200px;
    stroke-dashoffset: 0;
  }

  50% {
    stroke-dasharray: 100px, 200px;
    stroke-dashoffset: -15px;
  }

  100% {
    stroke-dasharray: 1px, 200px;
    stroke-dashoffset: -126px;
  }
`,E=typeof S!="string"?W`
        animation: ${S} 1.4s linear infinite;
      `:null,F=typeof P!="string"?W`
        animation: ${P} 1.4s ease-in-out infinite;
      `:null,I=e=>{const{classes:t,variant:r,color:a,disableShrink:n}=e,l={root:["root",r,`color${p(a)}`],svg:["svg"],circle:["circle",`circle${p(r)}`,n&&"circleDisableShrink"]};return B(l,O,t)},V=k("span",{name:"MuiCircularProgress",slot:"Root",overridesResolver:(e,t)=>{const{ownerState:r}=e;return[t.root,t[r.variant],t[`color${p(r.color)}`]]}})($(({theme:e})=>({display:"inline-block",variants:[{props:{variant:"determinate"},style:{transition:e.transitions.create("transform")}},{props:{variant:"indeterminate"},style:E||{animation:`${S} 1.4s linear infinite`}},...Object.entries(e.palette).filter(U()).map(([t])=>({props:{color:t},style:{color:(e.vars||e).palette[t].main}}))]}))),z=k("svg",{name:"MuiCircularProgress",slot:"Svg",overridesResolver:(e,t)=>t.svg})({display:"block"}),K=k("circle",{name:"MuiCircularProgress",slot:"Circle",overridesResolver:(e,t)=>{const{ownerState:r}=e;return[t.circle,t[`circle${p(r.variant)}`],r.disableShrink&&t.circleDisableShrink]}})($(({theme:e})=>({stroke:"currentColor",variants:[{props:{variant:"determinate"},style:{transition:e.transitions.create("stroke-dashoffset")}},{props:{variant:"indeterminate"},style:{strokeDasharray:"80px, 200px",strokeDashoffset:0}},{props:({ownerState:t})=>t.variant==="indeterminate"&&!t.disableShrink,style:F||{animation:`${P} 1.4s ease-in-out infinite`}}]}))),Q=T.forwardRef(function(t,r){const a=j({props:t,name:"MuiCircularProgress"}),{className:n,color:l="primary",disableShrink:g=!1,size:s=40,style:f,thickness:c=3.6,value:y=0,variant:d="indeterminate",...v}=a,o={...a,color:l,disableShrink:g,size:s,thickness:c,value:y,variant:d},h=I(o),u={},m={},x={};if(d==="determinate"){const C=2*Math.PI*((i-c)/2);u.strokeDasharray=C.toFixed(3),x["aria-valuenow"]=Math.round(y),u.strokeDashoffset=`${((100-y)/100*C).toFixed(3)}px`,m.transform="rotate(-90deg)"}return b.jsx(V,{className:D(h.root,n),style:{width:s,height:s,...m,...f},ownerState:o,ref:r,role:"progressbar",...x,...v,children:b.jsx(z,{className:h.svg,ownerState:o,viewBox:`${i/2} ${i/2} ${i} ${i}`,children:b.jsx(K,{className:h.circle,style:u,ownerState:o,cx:i,cy:i,r:(i-c)/2,fill:"none",strokeWidth:c})})})});function G(e){return M("MuiTypography",e)}R("MuiTypography",["root","h1","h2","h3","h4","h5","h6","subtitle1","subtitle2","body1","body2","inherit","button","caption","overline","alignLeft","alignRight","alignCenter","alignJustify","noWrap","gutterBottom","paragraph"]);const H={primary:!0,secondary:!0,error:!0,info:!0,success:!0,warning:!0,textPrimary:!0,textSecondary:!0,textDisabled:!0},J=A(),L=e=>{const{align:t,gutterBottom:r,noWrap:a,paragraph:n,variant:l,classes:g}=e,s={root:["root",l,e.align!=="inherit"&&`align${p(t)}`,r&&"gutterBottom",a&&"noWrap",n&&"paragraph"]};return B(s,G,g)},Z=k("span",{name:"MuiTypography",slot:"Root",overridesResolver:(e,t)=>{const{ownerState:r}=e;return[t.root,r.variant&&t[r.variant],r.align!=="inherit"&&t[`align${p(r.align)}`],r.noWrap&&t.noWrap,r.gutterBottom&&t.gutterBottom,r.paragraph&&t.paragraph]}})($(({theme:e})=>{var t;return{margin:0,variants:[{props:{variant:"inherit"},style:{font:"inherit",lineHeight:"inherit",letterSpacing:"inherit"}},...Object.entries(e.typography).filter(([r,a])=>r!=="inherit"&&a&&typeof a=="object").map(([r,a])=>({props:{variant:r},style:a})),...Object.entries(e.palette).filter(U()).map(([r])=>({props:{color:r},style:{color:(e.vars||e).palette[r].main}})),...Object.entries(((t=e.palette)==null?void 0:t.text)||{}).filter(([,r])=>typeof r=="string").map(([r])=>({props:{color:`text${p(r)}`},style:{color:(e.vars||e).palette.text[r]}})),{props:({ownerState:r})=>r.align!=="inherit",style:{textAlign:"var(--Typography-textAlign)"}},{props:({ownerState:r})=>r.noWrap,style:{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},{props:({ownerState:r})=>r.gutterBottom,style:{marginBottom:"0.35em"}},{props:({ownerState:r})=>r.paragraph,style:{marginBottom:16}}]}})),w={h1:"h1",h2:"h2",h3:"h3",h4:"h4",h5:"h5",h6:"h6",subtitle1:"h6",subtitle2:"h6",body1:"p",body2:"p",inherit:"p"},X=T.forwardRef(function(t,r){const{color:a,...n}=j({props:t,name:"MuiTypography"}),l=!H[a],g=J({...n,...l&&{color:a}}),{align:s="inherit",className:f,component:c,gutterBottom:y=!1,noWrap:d=!1,paragraph:v=!1,variant:o="body1",variantMapping:h=w,...u}=g,m={...g,align:s,color:a,className:f,component:c,gutterBottom:y,noWrap:d,paragraph:v,variant:o,variantMapping:h},x=c||(v?"p":h[o]||w[o])||"span",C=L(m);return b.jsx(Z,{as:x,ref:r,className:D(C.root,f),...u,ownerState:m,style:{...s!=="inherit"&&{"--Typography-textAlign":s},...u.style}})});export{Q as C,X as T};
