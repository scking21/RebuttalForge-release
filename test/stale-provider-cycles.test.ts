import { OPERATOR_REQUEST_HEADERS } from "../src/request-integrity.js";
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { scriptedBranch } from '../src/agent/test-double.js';
import { buyerOpensDispute, sellOne, startSystem } from './support/system.js';

async function setup(action:'contest'|'concede'='contest') {
 const model = scriptedBranch(action, {carrierName:'UPS',trackingNumber:'1Z999'});
 const sys = startSystem({model});
 const {captureId}=await sellOne(sys,'audit',{carrier:'UPS',number:'1Z999'});
 sys.records[captureId]=[{kind:'carrier_delivery_scan',label:'Delivery',fact:'UPS delivered 1Z999',recordedAt:'2026-10-04T00:00:00Z',carrier:'UPS',trackingNumber:'1Z999'}];
 const {disputeId}=await buyerOpensDispute(sys,captureId);
 sys.sim.setWebhookUrl(undefined);
 await sys.client.escalate(disputeId,'test','esc');
 await sys.client.requireEvidence(disputeId,'SELLER_EVIDENCE','req');
 const database=join(mkdtempSync(join(tmpdir(),'audit-persist-')),'case.sqlite');
 let store=new Store(database);
 let app=createApp({client:sys.client,store,model,sellerRecords:id=>sys.records[id]??[],webhookId:'WH-TEST'});
 const api=async (path:string,body?:unknown)=> {const r=await app.request(`/api/cases/${disputeId}/${path}`,{method:'POST',headers:{'content-type':'application/json',...OPERATOR_REQUEST_HEADERS},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 const approve=()=>api('approve',{approvedBy:'seller',recommendationRevision:store.getCase(disputeId)?.recommendationRevision});
 const restart=()=>{store.close();store=new Store(database);app=createApp({client:sys.client,store,model,sellerRecords:id=>sys.records[id]??[],webhookId:'WH-TEST'});};
 return {...sys,disputeId,api,approve,restart,db:()=>store};
}


const req=(date:string)=>({source:'REQUESTED_FROM_SELLER',evidence_type:'PROOF_OF_FULFILLMENT',date});

it('independent: a stale pre-action WAITING snapshot must not reopen after an observed UNDER_REVIEW result',async()=>{
 const s=await setup(); const stale=structuredClone(await s.client.getDispute(s.disputeId));
 await s.api('reassess'); await s.approve(); const first=await s.api('execute');
 expect(first.body.execution.afterSellerRequest.status).toBe('UNDER_REVIEW');
 s.restart(); vi.spyOn(s.client,'getDispute').mockResolvedValue(stale);
 const second=await s.api('reassess');
 console.log('STALE WAITING REOPEN',second.body.status,'history',second.body.executionHistory?.length);
 if(second.body.status==='recommended'){
   expect((await s.approve()).status).toBe(200);
   const post=vi.spyOn(s.client,'provideEvidence');
   const result=await s.api('execute');
   console.log('STALE WAITING SECOND POST ATTEMPTS',post.mock.calls.length,'result',result.status,result.body.error);
   expect(post).not.toHaveBeenCalled();
 }
 expect(second.body.status).toBe('executed');
});

it('independent: a request removed only in follow-up read then restored is not new work',async()=>{
 const s=await setup(); const d=s.sim.state.disputes.get(s.disputeId)!;
 d.evidences=[req('2026-10-01T00:00:00Z'),req('2026-10-02T00:00:00Z')];
 const original=[...d.evidences]; const provide=s.client.provideEvidence.bind(s.client);
 vi.spyOn(s.client,'provideEvidence').mockImplementation(async(...args)=>{const r=await provide(...args);d.status='WAITING_FOR_SELLER_RESPONSE';d.evidences=[original[1]!];return r;});
 await s.api('reassess'); await s.approve(); expect((await s.api('execute')).body.status).toBe('executed');
 s.restart(); d.evidences=original;
 const second=await s.api('reassess'); console.log('RESTORED OLD REQUEST',second.body.status);
 if(second.body.status==='recommended'){expect((await s.approve()).status).toBe(200);console.log('REPLAY RESULT',(await s.api('execute')).body.status);}
 console.log('RESTORED REQUEST PROVIDER EFFECTS',s.sim.state.actionLog.filter(a=>a.rel==='provide_evidence').length);
 expect(s.sim.state.actionLog.filter(a=>a.rel==='provide_evidence')).toHaveLength(1);
});

it('independent: replay A to B to A cannot execute historical request A again',async()=>{
 const s=await setup(); const d=s.sim.state.disputes.get(s.disputeId)!;
 const A=req('2026-10-01T00:00:00Z'), B=req('2026-10-02T00:00:00Z');
 d.evidences=[A]; const provide=s.client.provideEvidence.bind(s.client);
 vi.spyOn(s.client,'provideEvidence').mockImplementation(async(...args)=>{const r=await provide(...args);d.status='WAITING_FOR_SELLER_RESPONSE';return r;});
 await s.api('reassess'); await s.approve(); expect((await s.api('execute')).body.status).toBe('executed');
 d.evidences=[B]; expect((await s.api('reassess')).body.status).toBe('executed');
 expect((await s.approve()).status).toBe(409); expect((await s.api('execute')).body.status).toBe('executed');
 s.restart(); d.evidences=[A]; const third=await s.api('reassess');
 console.log('HISTORICAL A REPLAY',third.body.status,'history',third.body.executionHistory?.length);
 if(third.body.status==='recommended'){await s.approve();console.log('THIRD POST',(await s.api('execute')).body.status);}
 console.log('A B A PROVIDER EFFECTS',s.sim.state.actionLog.filter(a=>a.rel==='provide_evidence').length);
 expect(s.sim.state.actionLog.filter(a=>a.rel==='provide_evidence')).toHaveLength(1);
});
