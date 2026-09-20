import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import fixture from './fixtures/coverage-audit-ae.json';
import ciDiagrams from './fixtures/coverage-audit-ci-diagrams.json';
import { coverageAuditVerdict } from './helpers/coverage-audit-evidence';
import { recordE2E } from './helpers/e2e-helpers';
import { E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES } from './helpers/touchfiles';
import { selectTests } from './helpers/test-selection';

const clone = <T>(v:T):T => structuredClone(v);
const diagram = '```text\nsrc/billing.ts\n├── processPayment: happy path [TESTED]\n└── refundPayment [UNTESTED]\n```';
function synthetic() {
  const cwd = '/tmp/coverage-audit-evidence-owned';
  const files = {cwd, source:{path:path.join(cwd,'src/billing.ts'),content:fixture.files.source},
    tests:{path:path.join(cwd,'test/billing.test.ts'),content:fixture.files.tests}};
  const transcript:any[] = [{type:'system',subtype:'init',session_id:'parent',cwd}];
  for (const [id,file] of Object.entries({source:files.source,tests:files.tests})) {
    transcript.push({type:'assistant',session_id:'parent',parent_tool_use_id:null,message:{role:'assistant',content:[
      {type:'tool_use',id,name:'Read',input:{file_path:file.path}},
    ]}});
    transcript.push({type:'user',session_id:'parent',parent_tool_use_id:null,message:{role:'user',content:[
      {type:'tool_result',tool_use_id:id,content:file.content},
    ]}});
  }
  return {files,result:{exitReason:'success',browseErrors:[],output:diagram,transcript} as any};
}
const verdict = (s:ReturnType<typeof synthetic>) => coverageAuditVerdict(s.result,s.files);
const block = (s:ReturnType<typeof synthetic>,i:number) => s.result.transcript[i].message.content[0];

describe('coverage audit native evidence',()=>{
  test('all four exact completed public attempts delivered both files and the seeded diagram',()=>{
    expect(fixture.provenance.actualPassedCases).toBe(0);
    for(const row of fixture.rows){
      const files={cwd:row.cwd,source:{path:path.join(row.cwd,'src/billing.ts'),content:fixture.files.source},
        tests:{path:path.join(row.cwd,'test/billing.test.ts'),content:fixture.files.tests}};
      expect(coverageAuditVerdict(row.result as any,files)).toEqual({sourceRead:true,testsRead:true,diagram:true,passed:true,failures:[]});
    }
  });
  test('both exact CI diagrams retain covered payment and missing refund paths', () => {
    expect(ciDiagrams.provenance.recordedAttemptOutcomes).toEqual(['failed', 'failed']);
    expect(ciDiagrams.provenance.paidOutcomesReclassified).toBe(false);
    for (const row of ciDiagrams.diagrams) {
      const s = synthetic(); s.result.output = row.text;
      expect(verdict(s)).toEqual({ sourceRead: true, testsRead: true, diagram: true, passed: true, failures: [] });
    }
  });
  const displayLegend = (legend: string, covered = '#', gap = ' ') => '```text\n' + legend + '\n'
    + 'processPayment(amount, currency)\n└─ valid return success [' + covered + ']\n'
    + 'refundPayment(paymentId, reason)\n└─ valid return refunded [' + gap + '] GAP\n```';
  test('paid coverage diagrams accept a branch line without an arrowhead and a declared hash checkbox', () => {
    for (const output of [
      displayLegend('Legend:  [✓] tested    [✗] GAP (no test)    ── branch', '✓', '✗'),
      displayLegend('src/billing.ts — coverage map           [#] tested   [ ] GAP'),
      displayLegend('Legend: [#] tested [ ] no test'),
      displayLegend('src/billing.ts — coverage map [x] tested [ ] GAP', 'x'),
    ]) {
      const s = synthetic(); s.result.output = output;
      expect(verdict(s)).toEqual({ sourceRead: true, testsRead: true, diagram: true, passed: true, failures: [] });
    }
  });
  test('hash checkbox and branch-line legends retain explicit local meanings and ownership', () => {
    const caption = 'src/billing.ts — coverage map [#] tested [ ] GAP';
    for (const legend of ['', '> ' + caption, '"' + caption + '"', 'Example: ' + caption,
      'If approved: ' + caption, caption.replace('[#] tested [ ] GAP', '[#] GAP [ ] tested'),
      caption.replace('[ ] GAP', '[ ] tested'), caption.replace('[ ] GAP', '[#] GAP'),
      caption + ' except refunds', caption + '\nLegend: [#] untested [ ] covered',
      caption + '\nLegend:[#] untested [ ] covered',
      caption + '\nsrc/billing.ts — coverage map[#] untested [ ] covered',
      caption + '\nThis legend is withdrawn.', caption + '\nThis legend applies only if approved.',
    ]) {
      const s = synthetic(); s.result.output = displayLegend(legend); expect(verdict(s).diagram).toBe(false);
    }
    const valid = displayLegend(caption);
    for (const output of [
      '```text\n' + caption + '\n```\n' + displayLegend(''),
      valid.replace('processPayment', 'otherPayment'), valid.replace('refundPayment', 'otherRefund'),
      valid.replace('return success [#]', 'return success not [#]'),
      valid.replace('return success [#]', 'return success [#] -> [ ]'),
      valid.replace('return refunded [ ]', 'return refunded [ ] -> [#]'),
      valid.replace('return refunded [ ]', 'return refunded [ ] [#]'),
      valid.replace('return success [#]', 'return success    ├─ [#]'),
      '````markdown\n' + valid + '\n````', 'Example:\n' + valid,
      displayLegend('Legend: [✓] tested [✗] GAP ── covered', '✓', '✗'),
      displayLegend('Legend: [✓] tested [✗] GAP ── branch except refunds', '✓', '✗'),
    ]) {
      const s = synthetic(); s.result.output = output; expect(verdict(s).diagram).toBe(false);
    }
    const s = synthetic(); s.result.output = valid; s.result.transcript = [];
    expect(verdict(s).diagram).toBe(true); expect(verdict(s).passed).toBe(false);
  });
  test('CI symbol legends remain current, unambiguous and owned by their diagram', () => {
    for (const row of ciDiagrams.diagrams) {
      const text = row.text, key = text.split('\n').find(line => line.startsWith('Legend:'))!;
      for (const replacement of ['', '> ' + key, 'Source: ' + key, key + ' except refunds',
        key.replace(/covered(?: by a test)?/, 'untested'),
        key + '\nLegend: [✓] GAP [✗] covered', key + '\n  [✓] GAP [✗] covered',
        ...['Sample:', 'Example legend:', 'Illustration:'].map(label => label + '\n' + key)]) {
        const s = synthetic(); s.result.output = text.replace(key, replacement);
        expect(verdict(s).diagram, replacement).toBe(false);
      }
      for (const status of ['This legend is withdrawn.', 'Assessment complete; This legend is `no longer current`.',
        '**This legend** is “rejected”.', 'This legend applies only if approved.']) {
        const s = synthetic(); s.result.output = text.replace(/\n```$/, '\n' + status + '\n```');
        expect(verdict(s).diagram, status).toBe(false);
      }
      for (const output of ['Example:\n' + text, '````markdown\n' + text + '\n````',
        text.replace(/^```[^\n]*/, '```json'), '```\n' + key + '\n```\n' + text.replace(key, '')]) {
        const s = synthetic(); s.result.output = output; expect(verdict(s).diagram, output).toBe(false);
      }
      const s = synthetic(); s.result.output = text.replace(/\n```$/, '\nEarlier reviewer said "This legend is withdrawn."\n```');
      expect(verdict(s).diagram).toBe(true);
    }
  });
  test('six-column annotations cannot borrow sibling, prose or parallel-column markers', () => {
    const text = '```\nLegend: [✓] covered by a test [✗] GAP — no test exercises this path\n'
      + 'processPayment(amount, currency)\n└── happy return success\n      [✓] covered\n'
      + 'refundPayment(paymentId, reason)\n└── return refunded\n      [✗] GAP\n```';
    for (const output of [text.replace('      [✓]', 'unrelatedPayment()\n      [✓]'),
      text.replace('      [✓]', '      Earlier example:\n      [✓]'),
      text.replace('      [✓]', '                                                              [✓]'),
      text.replace('      [✓]', '      [✗]'), text.replace('      [✗]', '      [✓]'),
      text.replace('└── happy return success\n      [✓]', '└── happy return success     ├── [✓]')]) {
      const s = synthetic(); s.result.output = output; expect(verdict(s).diagram).toBe(false);
    }
    const s = synthetic(); s.result.output = text; expect(verdict(s).passed).toBe(true);
  });
  test.each([
    '```text\nsrc/billing.ts\n├── refundPayment [UNTESTED]\n└── processPayment: happy path [TESTED]\n```',
    'src/billing.ts\n├── processPayment: happy path [TESTED]\n└── refundPayment [UNTESTED]',
  ])('function order and optional fencing do not change valid coverage evidence: %s', output=>{
    const s=synthetic();s.result.output=output;expect(verdict(s).diagram).toBe(true);
  });
  test('direct Read, literal cat/sed and delivered native line gutters are valid',()=>{
    for(const command of ['cat -n src/billing.ts',"sed -n '1,200p' 'src/billing.ts'",'cat -- "src/billing.ts"']){
      const s=synthetic();Object.assign(block(s,1),{name:'Bash',input:{command}});
      block(s,2).content=fixture.files.source.split('\n').map((line,i)=>`${i+1}\t${line}`).join('\n');
      expect(verdict(s).passed).toBe(true);
    }
    const s=synthetic();block(s,2).content=[{type:'text',text:fixture.files.source.split('\n').map((line,i)=>`${i+1}→${line}`).join('\n')}];
    expect(verdict(s).passed).toBe(true);
  });
  function mixedDisplay(context: boolean) {
    const s = synthetic();
    const command = context
      ? 'cat review/specialists/testing.md && echo ==== SRC ==== && cat -n src/billing.ts && echo ==== TEST ==== && cat -n test/billing.test.ts && echo ==== GIT ==== && git log --oneline main..HEAD; git diff main --stat'
      : 'cat -n test/billing.test.ts && git log --oneline main..feature/billing 2>/dev/null; git diff main...feature/billing --stat 2>/dev/null';
    const numbered = (body: string) => body.replace(/\n$/, '').split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n');
    if (context) s.result.transcript.splice(1, 2);
    const use = s.result.transcript.at(-2).message.content[0];
    const result = s.result.transcript.at(-1).message.content[0];
    Object.assign(use, {name: 'Bash', input: {command}});
    result.content = context
      ? '# Testing Specialist Review Checklist\n\nCoverage Gaps\n==== SRC ====\n' + numbered(s.files.source.content)
        + '\n==== TEST ====\n' + numbered(s.files.tests.content) + '\n==== GIT ===='
      : numbered(s.files.tests.content);
    return {s, use, result};
  }
  test('mixed Git display tails retain separately delivered files and numbered reads after context', () => {
    // Shell forms from the two failed 2026-09-20 paid /review captures.
    for (const context of [false, true]) expect(verdict(mixedDisplay(context).s).passed).toBe(true);
  });
  test('mixed display reads retain ordered bodies and successful parent ownership', () => {
    for (const context of [false, true]) for (const mutate of [
      (x: ReturnType<typeof mixedDisplay>) => { x.result.is_error = true; },
      (x: ReturnType<typeof mixedDisplay>) => { x.result.content = 'test/billing.test.ts was read'; },
      (x: ReturnType<typeof mixedDisplay>) => { x.result.content = x.result.content.replace(/.*import \{ describe.*\n/, ''); },
      (x: ReturnType<typeof mixedDisplay>) => { x.s.result.transcript.at(-1).session_id = 'foreign'; },
      (x: ReturnType<typeof mixedDisplay>) => { x.s.result.transcript.at(-1).parent_tool_use_id = 'child'; },
      (x: ReturnType<typeof mixedDisplay>) => { x.result.tool_use_id = 'unpaired'; },
      (x: ReturnType<typeof mixedDisplay>) => { x.s.result.transcript.push(clone(x.s.result.transcript.at(-1))); },
    ]) {
      const x = mixedDisplay(context); mutate(x); expect(verdict(x.s).testsRead).toBe(false);
    }
    for (const context of [false, true]) for (const suffix of [
      'git diff main --output=src/billing.ts --stat', 'git diff main --ext-diff --stat',
      'git diff main --stat > output.txt', 'git diff main --stat || echo ok',
    ]) {
      const x = mixedDisplay(context); x.use.input.command = x.use.input.command.replace(/git diff[^;]+$/, suffix);
      expect(verdict(x.s).testsRead).toBe(false);
    }
    for (const prefix of ['cat ../foreign.md', 'cat --help.md', 'cat /foreign.md', 'cat "$CONTEXT"', 'cat review/specialists/testing.md | head -2',
      'false', 'python3 -c "pass"', 'echo -e "replacement"', 'cat review/specialists/testing.md; false']) {
      const x = mixedDisplay(true); x.use.input.command = x.use.input.command.replace('cat review/specialists/testing.md', prefix);
      expect(verdict(x.s).sourceRead).toBe(false); expect(verdict(x.s).testsRead).toBe(false);
    }
    const x = mixedDisplay(true); x.result.content = x.result.content.replace('==== SRC ====', '==== OTHER ====');
    expect(verdict(x.s).sourceRead).toBe(false); expect(verdict(x.s).testsRead).toBe(false);
    const repeated = mixedDisplay(true); repeated.result.content += '\n==== SRC ====';
    expect(verdict(repeated.s).sourceRead).toBe(false); expect(verdict(repeated.s).testsRead).toBe(false);
    const missing = mixedDisplay(true); missing.result.content = missing.result.content.slice(missing.result.content.indexOf('==== SRC ===='));
    expect(verdict(missing.s).sourceRead).toBe(false); expect(verdict(missing.s).testsRead).toBe(false);
  });
  test('each exact source and test file must be successfully delivered',()=>{
    for(const mutate of [
      (s:any)=>{block(s,2).content='src/billing.ts was read';},
      (s:any)=>{block(s,2).content=fixture.files.source.split('\n').slice(0,3).join('\n');},
      (s:any)=>{block(s,2).is_error=true;},
      (s:any)=>{block(s,3).input.file_path=s.files.source.path;},
      (s:any)=>{block(s,4).content=fixture.files.source;},
      (s:any)=>{block(s,1).input.file_path=path.join(s.files.cwd,'other/billing.ts');},
      (s:any)=>{s.files.tests.path=s.files.source.path;},
    ]){const s=synthetic();mutate(s);expect(verdict(s).passed).toBe(false);}
  });
  test('unpaired, repeated, child and foreign events cannot supply parent file evidence',()=>{
    for(const mutate of [
      (s:any)=>{s.result.transcript.splice(1,1);},
      (s:any)=>{[s.result.transcript[1],s.result.transcript[2]]=[s.result.transcript[2],s.result.transcript[1]];},
      (s:any)=>{s.result.transcript[2].session_id='foreign';},
      (s:any)=>{s.result.transcript[2].parent_tool_use_id='agent';},
      (s:any)=>{s.result.transcript[1].parent_tool_use_id='agent';},
      (s:any)=>{s.result.transcript[2].message.role='assistant';},
      (s:any)=>{s.result.transcript.push(clone(s.result.transcript[2]));},
      (s:any)=>{s.result.transcript.push(clone(s.result.transcript[1]));},
      (s:any)=>{s.result.transcript[0].cwd+='/sibling';},
      (s:any)=>{s.result.transcript.push(clone(s.result.transcript[0]));},
      (s:any)=>{s.result.transcript[0].session_id='foreign';},
      (s:any)=>{s.result.transcript[0].type='user';},
      (s:any)=>{s.result.transcript.shift();},
    ]){const s=synthetic();mutate(s);expect(verdict(s).passed).toBe(false);}
  });
  test('quoted metadata, counters and undeclared shell reads do not substitute for actual delivery',()=>{
    for(const command of [
      "echo 'cat src/billing.ts'",'false && cat src/billing.ts','cat src/billing.ts | head -2',
      'cd ../sibling; cat src/billing.ts',"if true; then cat src/billing.ts; fi",'cat "$SOURCE"',
      "cat <<'EOF'\ncat src/billing.ts\nEOF",'f() {\ncat src/billing.ts\n}',
      '(\ncat src/billing.ts\n)',
    ]){const s=synthetic();Object.assign(block(s,1),{name:'Bash',input:{command}});expect(verdict(s).passed).toBe(false);}
    const s=synthetic();s.result.toolCalls=[{tool:'Read',input:{file_path:s.files.source.path}},{tool:'Read',input:{file_path:s.files.tests.path}}];
    s.result.transcript=[s.result.transcript[0],{type:'assistant',session_id:'parent',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(s.result.transcript.slice(1))}]}}];
    expect(verdict(s).sourceRead).toBe(false);expect(verdict(s).testsRead).toBe(false);
  });
  test('a commented read cannot borrow printed bytes; quoted hash paths remain literal',()=>{
    const s=synthetic();
    const command=`printf '${Buffer.from(fixture.files.source).toString('base64')}' | base64 -d; # only printed bytes; cat src/billing.ts`;
    Object.assign(block(s,1),{name:'Bash',input:{command}});
    expect(verdict(s).sourceRead).toBe(false);
    const quoted=synthetic();quoted.files.source.path=path.join(quoted.files.cwd,'src/billing#branch.ts');
    Object.assign(block(quoted,1),{name:'Bash',input:{command:"cat 'src/billing#branch.ts'"}});
    expect(verdict(quoted).sourceRead).toBe(true);
  });
  test('completion and tool errors remain final gate failures despite genuine delivery',()=>{
    for(const exitReason of ['timeout','exit_code_1']){const s=synthetic();s.result.exitReason=exitReason;expect(verdict(s).passed).toBe(false);}
    const s=synthetic();s.result.browseErrors=['read failed'];expect(verdict(s).passed).toBe(false);
  });
  test('coverage markers must belong to the seeded payment and refund functions',()=>{
    for(const output of [
      diagram.replace('[TESTED]','[UNTESTED]'),diagram.replace('[UNTESTED]','[TESTED]'),
      diagram.replace('processPayment','processPaymentExample'),diagram.replace('refundPayment','refundPaymentExample'),
      '```\n├── processPayment: happy path [TESTED]\n└── refundPayment [TESTED]\n└── unrelatedPayment [UNTESTED]\n```',
      '```\n├── processPayment: happy path [TESTED]\n```\n```\n└── refundPayment [UNTESTED]\n```',
    ]){const s=synthetic();s.result.output=output;expect(verdict(s).diagram).toBe(false);}
  });
  test('quoted and nested source examples are not the generated coverage diagram',()=>{
    for(const output of [diagram.split('\n').map(line=>'> '+line).join('\n'), '````markdown\n'+diagram+'\n````']){
      const s=synthetic();s.result.output=output;expect(verdict(s).diagram).toBe(false);
    }
  });
  test.each([
    diagram.replace('[UNTESTED]','[NOT UNTESTED]'),
    diagram.replace('[UNTESTED]','[UNTESTED] is false; this function is fully covered.'),
    'Example only; this diagram is not the audit result.\n'+diagram,
  ])('negated gaps and explicitly labeled examples are not audit findings: %s', output=>{
    const s=synthetic();s.result.output=output;expect(verdict(s).diagram).toBe(false);
  });
  test('collector receives exactly the asserted verdict even when process exit succeeded',()=>{
    for(const valid of [true,false]){
      const s=synthetic();if(!valid)s.result.output='No diagram produced.';
      Object.assign(s.result,{toolCalls:[],duration:1,costEstimate:{estimatedCost:0,turnsUsed:1,estimatedTokens:1}});
      const v=verdict(s),entries:any[]=[];
      recordE2E({addTest:(entry:any)=>entries.push(entry)} as any,'coverage','fixture',s.result,{passed:v.passed,error:v.failures.length?v.failures.join('; '):undefined});
      expect(entries).toHaveLength(1);expect(entries[0].passed).toBe(valid);expect(entries[0].error).toBe(valid?undefined:v.failures.join('; '));
    }
  });
  test('coverage evidence files select their exact registered consumers',()=>{
    for(const file of ['test/helpers/coverage-audit-evidence.ts','test/coverage-audit-evidence.test.ts','test/fixtures/coverage-audit-ae.json','test/fixtures/coverage-audit-ci-diagrams.json']){
      expect(selectTests([file],E2E_TOUCHFILES,GLOBAL_TOUCHFILES).selected.sort()).toEqual(file === 'test/helpers/coverage-audit-evidence.ts' ? ['plan-eng-coverage-audit','review-coverage-audit','ship-coverage-audit'] : ['plan-eng-coverage-audit','review-coverage-audit']);
      expect(selectTests([file],LLM_JUDGE_TOUCHFILES,GLOBAL_TOUCHFILES).selected).toEqual([]);
    }
  });
});
