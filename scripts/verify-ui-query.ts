/** Opt-in live acceptance: only a disposable no-activate fixture, never personal app data. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FlaUiAdapter } from '../src/Adapters/FlaUiAdapter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { killProcessTree } from '../src/Core/ResourceManager.js';

const output = path.resolve('test-tmp', 'ui-query-' + Date.now());
await fs.mkdir(output, {recursive:true});
const fixture = spawn(path.resolve('tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe'),
  ['--background-fixture','--query-fixture','--auto-close=60000'], {stdio:['ignore','pipe','pipe'],windowsHide:true});
const client = new Client({name:'query-acceptance',version:'1'});
const transport = new StdioClientTransport({command:process.execPath,args:['dist/index.js','--workspace',process.cwd()],stderr:'pipe'});
const foreground: string[] = [];
const measurements: any[] = [];
let failure: string | undefined;
try {
  const target = await new Promise<{pid:number;hwnd:string}>((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('fixture readiness timeout')),10000);
    let buffer='';
    fixture.stdout!.on('data',chunk => {
      buffer+=chunk.toString(); let index:number;
      while ((index=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);
        if(line.startsWith('FOREGROUND ')) foreground.push(line);
        const match=line.match(/^READY (\d+) (0x[\dA-F]+)$/);
        if(match) {clearTimeout(timer);resolve({pid:+match[1],hwnd:match[2]});}
      }
    });
    fixture.once('error',e=>{clearTimeout(timer);reject(e);});
  });
  await client.connect(transport);
  async function inspect(label:string, args:Record<string,unknown>, review=false) {
    const start=performance.now();
    const result=await client.callTool({name:review?'wincode_ui_review':'wincode_ui_inspect',arguments:{...target,backgroundOnly:true,capture:'none',maxNodes:300,...args}});
    const blocks=result.content as Array<{type:string;text?:string;data?:string}>;
    const text=blocks[0].text!; const value=JSON.parse(text);
    assert.equal(value.success,true, text);
    measurements.push({label,ms:Math.round(performance.now()-start),bytes:Buffer.byteLength(text),peakMiB:value.helperPeakWorkingSetBytes/1048576,totalNodes:value.totalNodes,visitedNodes:value.queryResult?.visitedNodes});
    await fs.writeFile(path.join(output,label+'.json'),text);
    const image=blocks.find(b=>b.type==='image');if(image)await fs.writeFile(path.join(output,label+'.png'),Buffer.from(image.data!,'base64'));
    process.kill(target.pid,0);
    return value;
  }
  const full=await inspect('full',{});
  assert.ok(full.totalNodes>100);
  assert.equal(full.tree.states,undefined);
  const one=await inspect('unique',{query:{automationId:'btnNormalAction',controlType:'Button'},readStates:true});
  assert.equal(one.queryResult.status,'unique');assert.equal(one.tree.automationId,'btnNormalAction');
  assert.equal(one.tree.isEnabled,false);assert.equal(one.treeComplete,true);assert.equal(one.truncated,false);
  assert.equal(one.tree.states.toggle,'unsupported');assert.ok(one.totalNodes<full.totalNodes);
  const leaf=await inspect('leaf',{query:{name:'Normal Action',controlType:'Text'},maxDepth:1});
  assert.equal(leaf.treeComplete,true);assert.equal(leaf.truncated,false);
  const duplicate=await inspect('duplicate',{query:{automationId:'duplicateItem'}});
  assert.equal(duplicate.queryResult.status,'ambiguous');assert.equal(duplicate.queryResult.matches.length,2);assert.equal(duplicate.tree,undefined);
  const limited=await inspect('limited',{query:{automationId:'btnNormalAction',maxSearchNodes:2}});
  assert.equal(limited.queryResult.status,'incomplete');assert.equal(limited.tree,undefined);
  const capped=await inspect('match-limit',{query:{automationId:'duplicateItem',maxMatches:1}});
  assert.equal(capped.queryResult.status,'incomplete');
  const absent=await inspect('absent',{query:{automationId:'btnNormalAction',name:'wrong'}});
  assert.equal(absent.queryResult.status,'not-found');assert.equal(absent.tree,undefined);
  const toggle=await inspect('toggle',{query:{automationId:'queryToggle'},readStates:true});
  assert.equal(toggle.tree.states.toggle,'On');
  const expand=await inspect('expand',{query:{automationId:'queryExpand'},readStates:true});
  assert.equal(expand.tree.states.expandCollapse,'Expanded');
  const selection=await inspect('selection',{query:{name:'Selected',controlType:'ListItem'},readStates:true});
  assert.equal(selection.tree.states.selection,'selected');
  const review=await inspect('review',{query:{automationId:'btnNormalAction'},candidateFiles:['tests/fixtures/wpf-ui-review/MainWindow.xaml'],capture:'annotated'},true);
  assert.equal(review.sourceEvidence.runtimeSourceVerified,false);assert.ok(review.sourceEvidence.nodes[0].candidates.length>0);
  assert.ok(['printWindowDwm','printWindow'].includes(review.captureMethod));
  for(let i=0;i<5;i++) await inspect('repeat-'+i,{query:{automationId:'btnNormalAction'}});
  // Exercise actual helper reclamation on the new query path, not only cancellation of a Promise.
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  try {
    for (const mode of ['cancel','timeout']) {
      const abort = new AbortController();
      const pending = adapter.inspect({...target,backgroundOnly:true,query:{automationId:'btnNormalAction'},timeoutMs:mode==='timeout'?250:5000},abort.signal);
      let helperPid:number|null = null;
      const deadline = Date.now()+1000;
      while (!helperPid && Date.now()<deadline) {
        helperPid=adapter.getRuntimeStatus().activePid;
        if(!helperPid) await new Promise(r=>setTimeout(r,10));
      }
      assert.ok(helperPid,'must observe a real helper before cancellation');
      if(mode==='cancel') abort.abort();
      const result=await pending;
      assert.equal(result.errorCode,mode==='cancel'?'CANCELLED':'TIMEOUT');
      assert.equal(adapter.isRunning,false);
      assert.throws(()=>process.kill(helperPid!,0),{code:'ESRCH'});
      process.kill(target.pid,0);
    }
  } finally { await adapter.dispose(); }
  const health=await client.callTool({name:'wincode_hello_world',arguments:{}});
  const status=JSON.parse((health.content as any)[0].text).health;
  assert.equal(status.flaui.runtime.activePid,null);assert.equal(status.flaui.runtime.isRunning,false);
  assert.ok(foreground.every(s=>!s.startsWith('FOREGROUND '+target.pid+' ')));
} catch(e) { failure=String(e);process.exitCode=1; }
finally {
  await client.close();await killProcessTree(fixture);
  const report={failure,measurements,foregroundUnchangedInSamples:foreground.length>0&&foreground.every(s=>s===foreground[0]),sampleCount:foreground.length,
    limitation:'100ms foreground samples are not proof of zero focus changes. Helper peak RSS is reported before final serialization; not a hard cap.'};
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
}
