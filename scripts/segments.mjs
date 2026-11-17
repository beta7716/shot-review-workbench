#!/usr/bin/env node
import {loadSegmentManifest,initializeSegmentCache,renderSelectedSegments,renderSelectedSegmentsWorker,composeSegments} from '../lib/segments.mjs';
import {publishComposedPreview} from '../lib/publish-preview.mjs';
const args=process.argv.slice(2),action=args.shift()||'status';
const take=(name)=>{const i=args.indexOf(name);return i<0?undefined:args.splice(i,2)[1];};
const project=take('--project')||process.env.VIDEO_PROJECT_ROOT;
let options={};
const passed=take('--options-json');if(passed)options=JSON.parse(passed);
for(const [flag,key] of [['--data-root','dataRoot'],['--lib','libRoot'],['--output','outputName'],['--source','sourceVideo'],['--dependencies','dependenciesFile'],['--query','query']]){const value=take(flag);if(value!==undefined)options[key]=value;}
const shots=take('--shots');if(shots!==undefined)options.shotIds=shots.split(',').filter(Boolean).map(Number);
if(args.includes('--allow-stale')){args.splice(args.indexOf('--allow-stale'),1);options.allowStaleReuse=true;}
if(args.includes('--force')){args.splice(args.indexOf('--force'),1);options.force=true;}
if(args.length)throw new Error(`Unknown arguments: ${args.join(' ')}`);
options.onProgress=event=>process.stdout.write(JSON.stringify({type:'progress',...event})+'\n');
try{
  const methods={status:loadSegmentManifest,init:initializeSegmentCache,render:renderSelectedSegments,'render-worker':renderSelectedSegmentsWorker,compose:composeSegments};
  if(!methods[action])throw new Error('Usage: segments.mjs status|init|render --shots 3,4|compose [--project path] [--output name]');
  const result=await methods[action](project,options);
  if(action==='compose')await publishComposedPreview(project,result,options);
  process.stdout.write(JSON.stringify({type:'result',result})+'\n');
}catch(error){process.stderr.write(`${error.stack||error.message}\n`);process.exitCode=1;}
