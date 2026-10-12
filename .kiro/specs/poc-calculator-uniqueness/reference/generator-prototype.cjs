const { F, r2 } = require('./formula.cjs');
function fnv(s){let h=0x811c9dc5;for(const ch of Buffer.from(s,'utf8')){h^=ch;h=Math.imul(h,0x01000193)>>>0;}return h>>>0;}
function mulberry(a){return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function rng(seed){const r=mulberry(fnv(seed));const int=(a,b)=>a+Math.floor(r()*(b-a+1));const pick=a=>a[Math.floor(r()*a.length)];const sample=(a,k)=>{const c=[...a];for(let i=0;i<k;i++){const j=i+Math.floor(r()*(c.length-i));[c[i],c[j]]=[c[j],c[i]];}return c.slice(0,k);};const uni=(a,b)=>a+r()*(b-a);return{int,pick,sample,uni};}
const ROLE_TYPES={web:['m6i.large','m7i.large','m7g.large','c7i.large','t3.large','t3.xlarge','m6i.xlarge','m7i.xlarge','m7g.xlarge'],app:['m6i.xlarge','m7i.xlarge','m7g.xlarge','m6i.2xlarge','m7i.2xlarge','m7g.2xlarge','r6i.xlarge','r7g.xlarge'],worker:['c6i.xlarge','c6i.2xlarge','c7i.xlarge','c7i.2xlarge','c7g.xlarge'],batch:['c7i.2xlarge','c6i.2xlarge','m7i.2xlarge','r7i.xlarge','r6i.xlarge'],api:['m7g.large','m7g.xlarge','c7g.xlarge','c7i.large','m6i.large']};
const RDS_T=['db.t4g.large','db.m6g.large','db.m6g.xlarge','db.m7g.large','db.m7g.xlarge','db.r6g.large','db.r6g.xlarge','db.r7g.large'];
const AUR_T=['db.r6g.large','db.r6g.xlarge','db.r7g.large','db.r7g.xlarge'];
const EC_T=['cache.m6g.large','cache.m6g.xlarge','cache.m7g.large','cache.m7g.xlarge'];
const SELF_DB_T=['r6i.large','r6i.xlarge','r7i.large','r7i.xlarge','m7i.xlarge','r7g.large','r7g.xlarge'];
const AUX={
 elasticache:R=>({instanceType:R.pick(EC_T),nodes:R.int(1,3)}),
 'nat-gateway':R=>({gateways:R.int(1,3),gbPerGateway:R.int(5,60)*10}),
 waf:R=>({webAcls:R.int(1,2),rulesPerAcl:R.int(3,15),managedGroupsPerAcl:R.int(1,4),requestsMillions:R.int(5,120)}),
 cloudtrail:R=>({writeTrails:2,eventsMillions:R.int(1,5)}),
 'api-gateway-http':R=>({requestsMillions:R.int(5,150)}),
 route53:R=>({hostedZones:R.int(1,8),queriesMillions:R.int(1,60)}),
 'secrets-manager':R=>({secrets:R.int(5,60),apiCalls:R.int(1,50)*10000}),
 'backup-ebs':R=>({gb:R.int(10,150)*10}),
 efs:R=>({storageGb:R.int(5,80)*10,readGb:R.int(0,20)*5,writeGb:R.int(0,20)*5}),
 ecr:R=>({gb:R.int(2,60)*10}),
 kms:R=>({keys:R.int(1,12),requests:R.int(1,100)*10000}),
 sqs:R=>({requestsMillions:R.int(5,200)}),
 'ebs-volume':R=>({volumes:R.int(1,4),gbPerVolume:R.int(5,50)*10}),
};
const sigOf={elasticache:p=>`elasticache:${p.instanceType}x${p.nodes}`,'nat-gateway':p=>`nat:x${p.gateways}`,'ebs-volume':p=>`ebs-volume:x${p.volumes}`};
function build(mrr,seed){
 const R=rng(seed);
 const lo=mrr+100, hi=mrr+150.99;
 const target=mrr+101+R.int(0,48)+R.int(1,99)/100;
 const items=[]; const add=(svc,p,role)=>items.push({svc,p,role});
 // skeleton
 add('alb',{count:R.int(1,3),gbPerHour:R.pick([0.2,0.3,0.5,0.8,1,1.5])});
 add('cloudwatch',{metrics:R.int(10,150),logGb:R.int(5,150),dashboards:R.int(1,8),alarms:R.int(5,60)});
 const s3={gb:Math.max(100,Math.round(mrr*R.uni(0.1,0.4)/10)*10),putRequests:R.int(1,50)*10000,getRequests:R.int(1,100)*100000};
 add('s3',s3);
 // aux
 const auxK=R.int(3,6); let aux=R.sample(Object.keys(AUX),auxK).map(k=>({svc:k,p:AUX[k](R)}));
 // db
 const dbOpt=R.pick(['rds-mysql','rds-postgresql','aurora-mysql','ec2-self-hosted']);
 const dbBudget=target*R.uni(0.12,0.30);
 let db;
 if(dbOpt==='rds-mysql'||dbOpt==='rds-postgresql'){const storageGb=R.int(5,100)*10, backupGb=R.int(0,50)*10;let best=null;for(const t of RDS_T)for(const n of [1,2])for(const d of ['Single-AZ','Multi-AZ']){const p={instanceType:t,nodes:n,deployment:d,storageGb,backupGb};const c=F[dbOpt](p);const e=Math.abs(c-dbBudget);if(!best||e<best.e)best={p,e};}db={svc:dbOpt,p:best.p};}
 else if(dbOpt==='aurora-mysql'){const storageGb=R.int(5,100)*10;let best=null;for(const t of AUR_T)for(const n of [1,2,3]){const p={instanceType:t,nodes:n,storageGb};const e=Math.abs(F['aurora-mysql'](p)-dbBudget);if(!best||e<best.e)best={p,e};}db={svc:'aurora-mysql',p:best.p};}
 else{const t=R.pick(SELF_DB_T),gb=R.int(10,50)*10;const per=F.ec2({instanceType:t,count:1,storageGbPerInstance:gb});db={svc:'ec2',p:{instanceType:t,count:Math.max(1,Math.round(dbBudget/per)),storageGbPerInstance:gb},role:'db'};}
 // roles
 const roleN=R.int(1,3); const roles=R.sample(Object.keys(ROLE_TYPES),roleN).map(role=>({role,t:ROLE_TYPES[role][Math.floor(R.uni(0,1)*ROLE_TYPES[role].length)],gb:R.int(3,25)*10,w:R.uni(1,3)}));
 const cost=it=>r2(F[it.svc](it.p));
 const sumFixed=()=>[...items,db,...aux].reduce((s,it)=>s+cost(it),0);
 // 预算不足时丢最贵的辅助服务
 const minRoles=()=>roles.reduce((s,r)=>s+F.ec2({instanceType:r.t,count:1,storageGbPerInstance:r.gb}),0);
 const fits=()=>sumFixed()+minRoles()<=target-1;
 while(!fits() && aux.length){aux.sort((a,b)=>cost(b)-cost(a));aux.shift();}
 if(!fits() && roles.length>1) roles.splice(1);
 if(!fits()) db={svc:'rds-mysql',p:{instanceType:'db.t4g.large',nodes:1,deployment:'Single-AZ',storageGb:20,backupGb:0}};
 if(!fits()) throw new Error('budget too small');
 const R0=target-sumFixed(); const W=roles.reduce((s,r)=>s+r.w,0);
 const perOf=r=>F.ec2({instanceType:r.t,count:1,storageGbPerInstance:r.gb});
 const spare=R0-roles.reduce((s,r)=>s+perOf(r),0);
 const ec2Items=roles.map(r=>({svc:'ec2',role:r.role,p:{instanceType:r.t,count:1+Math.floor(spare*r.w/W/perOf(r)),storageGbPerInstance:r.gb}}));
 { const per=e=>F.ec2({...e.p,count:1}); let rest=target-sumFixed()-ec2Items.reduce((s,e)=>s+F.ec2(e.p),0); const cheap=[...ec2Items].sort((a,b)=>per(a)-per(b))[0]; while(rest>=per(cheap)){cheap.p.count++;rest-=per(cheap);}
   const most=[...ec2Items].sort((a,b)=>b.p.count-a.p.count)[0]; const step=most.p.count*10*0.0864;
   while(rest>=step+2){most.p.storageGbPerInstance+=10;rest-=step;} }
 const all=()=>[...ec2Items,...(db.role?[db]:[]),...items,...(db.role?[]:[db]),...aux];
 const total=()=>r2(all().reduce((s,it)=>s+cost(it),0));
 // 收敛：S3 GB 吸收差额；超了就减实例
 for(let guard=0;guard<50;guard++){
   let t=total();
   if(t>hi){ const big=ec2Items.filter(e=>e.p.count>1).sort((a,b)=>cost(b)/b.p.count-cost(a)/a.p.count)[0]; if(big){big.p.count--;continue;} }
   const diff=target-t; const dg=Math.floor(diff/0.0225);
   if(s3.gb+dg<100){ const big=ec2Items.filter(e=>e.p.count>1).sort((a,b)=>cost(b)/b.p.count-cost(a)/a.p.count)[0]; if(big){big.p.count--;continue;} throw new Error('cannot converge'); }
   s3.gb+=dg; break;
 }
 let t=total(); if(Math.round(t*100)%100===0){s3.gb+=1;t=total();}
 if(t<lo||t>=mrr+151) throw new Error(`out of window ${t}`);
 const sig=[...ec2Items.map(e=>`ec2:${e.role}:${e.p.instanceType}x${e.p.count}`).sort(), db.role?`db:ec2-self-hosted:${db.p.instanceType}x${db.p.count}`:`db:${db.svc}:${db.p.instanceType}x${db.p.nodes}${db.p.deployment?':'+db.p.deployment:''}`, `alb:x${items[0].p.count}`, ...aux.map(a=>(sigOf[a.svc]||(p=>a.svc))(a.p)).sort()].join('|');
 return {total:t,sig,n:all().length,aux:aux.length,s3gb:s3.gb};
}
module.exports={build};
if(require.main===module){
 for(const mrr of [600,800,1000,1500,2400,7800,60000]){let s3max=0;
   const tot=new Map(),sig=new Set();let err=0,minAux=9,svcMin=99,svcMax=0;const errs=new Set();
   for(let i=0;i<1000;i++){try{const r=build(mrr,`ledger-${i}#0`);tot.set(r.total,(tot.get(r.total)||0)+1);sig.add(r.sig);s3max=Math.max(s3max,r.s3gb);minAux=Math.min(minAux,r.aux);svcMin=Math.min(svcMin,r.n);svcMax=Math.max(svcMax,r.n);}catch(e){err++;errs.add(e.message);}}
   const dupTotals=[...tot.values()].filter(v=>v>1).reduce((s,v)=>s+v,0);
   console.log(`MRR ${mrr}: err ${err} ${[...errs].join(',')} | 签名唯一 ${sig.size}/1000 | 总额撞车涉及 ${dupTotals} 条 | 服务数 ${svcMin}-${svcMax} | 最少辅助 ${minAux} | S3 最大 ${s3max} GB`);
 }
}
