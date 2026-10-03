const TRACKS=[
{name:'South Mountain Raceway',lat:40.1491,lon:-77.1470},
{name:'Beaver Springs Dragway',lat:40.7460,lon:-77.2090},
{name:'Maple Grove Raceway',lat:40.2127,lon:-75.9614},
{name:'Cecil County Dragway',lat:39.6387,lon:-75.9902},
{name:'Numidia Dragway',lat:40.8891,lon:-76.4000}
];
const MODELS=[
{id:'best_match',label:'Open-Meteo Best Match'},
{id:'gfs_seamless',label:'GFS'},
{id:'ecmwf_ifs025',label:'ECMWF IFS'}
];
const $=id=>document.getElementById(id);
const trackSelect=$('trackSelect'),dateInput=$('dateInput'),errorBox=$('errorBox');

function isoDateLocal(d=new Date()){
  const z=new Date(d.getTime()-d.getTimezoneOffset()*60000);
  return z.toISOString().slice(0,10);
}
function init(){
  TRACKS.forEach((t,i)=>{
    const o=document.createElement('option');
    o.value=i;o.textContent=t.name;trackSelect.appendChild(o);
  });
  dateInput.value=isoDateLocal();
  dateInput.min=isoDateLocal();
  const max=new Date();max.setDate(max.getDate()+6);dateInput.max=isoDateLocal(max);
  trackSelect.addEventListener('change',load);
  dateInput.addEventListener('change',load);
  $('refreshButton').addEventListener('click',load);
  if('serviceWorker'in navigator) navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
  load();
}
async function fetchJson(url,options={}){
  const r=await fetch(url,options);
  if(!r.ok) throw new Error('Weather request failed ('+r.status+')');
  return r.json();
}
async function getOpenMeteoModel(track,date,model){
  const hourly=['temperature_2m','relative_humidity_2m','dew_point_2m','precipitation_probability','precipitation','surface_pressure','wind_speed_10m','wind_gusts_10m','cloud_cover'];
  const qs=new URLSearchParams({
    latitude:track.lat,
    longitude:track.lon,
    hourly:hourly.join(','),
    temperature_unit:'fahrenheit',
    wind_speed_unit:'mph',
    precipitation_unit:'inch',
    timezone:'America/New_York',
    start_date:date,
    end_date:date,
    models:model
  });
  return fetchJson('https://api.open-meteo.com/v1/forecast?'+qs.toString());
}
async function getNws(track){
  const p=await fetchJson('https://api.weather.gov/points/'+track.lat+','+track.lon,{headers:{Accept:'application/geo+json'}});
  return fetchJson(p.properties.forecastHourly,{headers:{Accept:'application/geo+json'}});
}
function mean(a){const v=a.filter(Number.isFinite);return v.length?v.reduce((x,y)=>x+y,0)/v.length:0}
function weightedMean(values,weights){
  let sum=0,total=0;
  values.forEach((v,i)=>{if(Number.isFinite(v)){const w=Number(weights[i])||0;sum+=v*w;total+=w;}});
  return total?sum/total:mean(values);
}
function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function addDays(dateString,days){
  const d=new Date(dateString+'T12:00:00');
  d.setDate(d.getDate()+days);
  return isoDateLocal(d);
}
function forecastLeadDays(date){
  const today=new Date(isoDateLocal()+'T12:00:00');
  const target=new Date(date+'T12:00:00');
  return clamp(Math.round((target-today)/86400000),1,6);
}
function raceWindowTotals(data,field){
  const totals={};
  const times=data.hourly?.time||[],values=data.hourly?.[field]||[];
  times.forEach((t,i)=>{
    const h=Number(t.slice(11,13)),v=Number(values[i]);
    if(h<7||h>19||!Number.isFinite(v))return;
    const d=t.slice(0,10);
    totals[d]=(totals[d]||0)+v;
  });
  return totals;
}
function equalModelWeights(){
  const w=1/MODELS.length;
  return Object.fromEntries(MODELS.map(m=>[m.id,{weight:w,skill:null,samples:0}]));
}
async function getHistoricalWeights(track,date){
  const lead=forecastLeadDays(date);
  const end=addDays(isoDateLocal(),-2);
  const start=addDays(end,-29);
  const actualQs=new URLSearchParams({
    latitude:track.lat,longitude:track.lon,start_date:start,end_date:end,
    hourly:'precipitation',precipitation_unit:'inch',timezone:'America/New_York'
  });
  try{
    const actual=await fetchJson('https://archive-api.open-meteo.com/v1/archive?'+actualQs.toString());
    const actualTotals=raceWindowTotals(actual,'precipitation');
    const field='precipitation_previous_day'+lead;
    const results=await Promise.all(MODELS.map(async m=>{
      const qs=new URLSearchParams({
        latitude:track.lat,longitude:track.lon,start_date:start,end_date:end,
        hourly:field,precipitation_unit:'inch',timezone:'America/New_York',models:m.id
      });
      const data=await fetchJson('https://previous-runs-api.open-meteo.com/v1/forecast?'+qs.toString());
      const forecastTotals=raceWindowTotals(data,field);
      const scores=[];
      Object.keys(actualTotals).forEach(d=>{
        if(!Number.isFinite(forecastTotals[d]))return;
        const actualRain=actualTotals[d],forecastRain=forecastTotals[d];
        const actualWet=actualRain>=.01,forecastWet=forecastRain>=.01;
        let eventScore=1;
        if(actualWet&&!forecastWet)eventScore=0;
        else if(!actualWet&&forecastWet)eventScore=.5;
        const amountScore=1-Math.min(Math.abs(forecastRain-actualRain)/.25,1);
        scores.push(eventScore*.8+amountScore*.2);
      });
      if(scores.length<7)throw new Error('Not enough historical samples for '+m.label);
      return {id:m.id,skill:Math.round(mean(scores)*100),samples:scores.length};
    }));
    const raw=results.map(r=>Math.pow(Math.max(.25,r.skill/100),3));
    const total=raw.reduce((a,b)=>a+b,0)||1;
    return Object.fromEntries(results.map((r,i)=>[r.id,{...r,weight:raw[i]/total,lead}]));
  }catch(e){
    console.warn('Historical model weighting unavailable; using equal weights.',e);
    return equalModelWeights();
  }
}
function calcDA(tempF,rh,pressureHpa){
  if(!Number.isFinite(tempF)||!Number.isFinite(rh)||!Number.isFinite(pressureHpa)) return null;
  const tC=(tempF-32)*5/9;
  const es=6.112*Math.exp((17.67*tC)/(tC+243.5));
  const e=es*(rh/100),pd=pressureHpa-e;
  const rho=((pd*100)/(287.05*(tC+273.15)))+((e*100)/(461.495*(tC+273.15)));
  return Math.round((1-Math.pow(rho/1.225,1/5.25588))*145366.45);
}
function raceHours(data,date){
  const idx=[];
  (data.hourly?.time||[]).forEach((t,i)=>{
    const h=Number(t.slice(11,13));
    if(t.startsWith(date)&&h>=7&&h<=19) idx.push(i);
  });
  return idx;
}
function summarizeModel(data,date,label){
  const ix=raceHours(data,date);
  const rows=ix.map(i=>({
    time:data.hourly.time[i],
    pop:Number(data.hourly.precipitation_probability?.[i])||0,
    rain:Number(data.hourly.precipitation?.[i])||0,
    temp:Number(data.hourly.temperature_2m?.[i]),
    rh:Number(data.hourly.relative_humidity_2m?.[i]),
    dew:Number(data.hourly.dew_point_2m?.[i]),
    pressure:Number(data.hourly.surface_pressure?.[i]),
    wind:Number(data.hourly.wind_speed_10m?.[i])||0,
    gust:Number(data.hourly.wind_gusts_10m?.[i])||0,
    cloud:Number(data.hourly.cloud_cover?.[i])||0
  }));
  if(!rows.length) throw new Error(label+' returned no race-window data');
  const peak=Math.max(...rows.map(r=>r.pop));
  const total=rows.reduce((s,r)=>s+r.rain,0);
  const wetHours=rows.filter(r=>r.rain>=.01||r.pop>=60).length;
  return {id:arguments[3],label,rows,peak,total,wetHours};
}
function aggregateModels(models,skillWeights){
  const len=Math.min(...models.map(m=>m.rows.length));
  const modelWeights=models.map(m=>skillWeights?.[m.id]?.weight??(1/models.length));
  const rows=[];
  for(let i=0;i<len;i++){
    const set=models.map(m=>m.rows[i]);
    rows.push({
      time:set[0].time,
      pop:weightedMean(set.map(r=>r.pop),modelWeights),
      rain:weightedMean(set.map(r=>r.rain),modelWeights),
      temp:weightedMean(set.map(r=>r.temp),modelWeights),
      rh:weightedMean(set.map(r=>r.rh),modelWeights),
      dew:weightedMean(set.map(r=>r.dew),modelWeights),
      pressure:weightedMean(set.map(r=>r.pressure),modelWeights),
      wind:weightedMean(set.map(r=>r.wind),modelWeights),
      gust:weightedMean(set.map(r=>r.gust),modelWeights),
      cloud:weightedMean(set.map(r=>r.cloud),modelWeights)
    });
  }
  const peak=Math.max(...rows.map(r=>r.pop));
  const total=rows.reduce((s,r)=>s+r.rain,0);
  const wetHours=rows.filter(r=>r.rain>=.01||r.pop>=60).length;
  const avgRh=mean(rows.map(r=>r.rh));
  const avgWind=mean(rows.map(r=>r.wind));
  const avgCloud=mean(rows.map(r=>r.cloud));
  const avgTemp=mean(rows.map(r=>r.temp));
  const drying=clamp(Math.round(100-(avgRh*.55)-(avgCloud*.18)+(avgWind*1.4)+(avgTemp*.25)),0,100);
  const risk=clamp(Math.round(peak*.42+Math.min(total/.4,1)*32+Math.min(wetHours/5,1)*18+(drying<35?8:0)),0,100);
  return {rows,peak,total,wetHours,drying,risk};
}
function nwsForDate(nws,date){
  const rows=(nws.properties?.periods||[]).filter(p=>{
    const d=p.startTime.slice(0,10),h=Number(p.startTime.slice(11,13));
    return d===date&&h>=7&&h<=19;
  });
  return {
    peak:Math.max(0,...rows.map(p=>p.probabilityOfPrecipitation?.value||0)),
    summary:rows.map(p=>p.shortForecast).filter(Boolean).slice(0,3).join(' / ')
  };
}
function verdict(risk){if(risk<35)return['GO','good'];if(risk<65)return['CAUTION','warn'];return['NO-GO','bad']}
function fmtTime(s){const h=Number(s.slice(11,13));return new Intl.DateTimeFormat([],{hour:'numeric'}).format(new Date(2000,0,1,h))}
function confidence(models,nws){
  const peaks=models.map(m=>m.peak).concat(nws.peak);
  const spread=Math.max(...peaks)-Math.min(...peaks);
  if(spread<=15)return'High';
  if(spread<=30)return'Medium';
  return'Low';
}
function consensusLabel(models,nws){
  const wet=models.filter(m=>m.peak>=60||m.total>=.1).length+(nws.peak>=60?1:0);
  const total=models.length+1;
  if(wet===total)return'All sources show meaningful rain risk';
  if(wet>=Math.ceil(total*.75))return'Most sources show meaningful rain risk';
  if(wet<=1)return'Most sources are relatively dry';
  return'Sources are mixed';
}
async function load(){
  errorBox.hidden=true;
  $('decisionText').textContent='Loading…';
  const track=TRACKS[+trackSelect.value||0],date=dateInput.value;
  $('trackName').textContent=track.name;
  try{
    const modelPromises=MODELS.map(m=>getOpenMeteoModel(track,date,m.id).then(d=>summarizeModel(d,date,m.label,m.id)));
    const [modelResults,nws,skillWeights]=await Promise.all([Promise.all(modelPromises),getNws(track),getHistoricalWeights(track,date)]);
    const s=aggregateModels(modelResults,skillWeights),n=nwsForDate(nws,date),conf=confidence(modelResults,n);
    const blended=clamp(Math.round(s.risk*.75+n.peak*.25),0,100);
    const peakPop=Math.max(s.peak,n.peak);
    const wetSourceCount=modelResults.filter(m=>m.peak>=60||m.total>=.1).length+(n.peak>=60?1:0);
    let decisionRisk=blended;

    // Drag racing needs a more conservative rain call than a general outdoor forecast.
    // A 40-59% peak chance can no longer produce a green GO.
    if(peakPop>=40&&peakPop<60) decisionRisk=Math.max(decisionRisk,35);

    // At 60%+ the forecast is at least a strong CAUTION. If that signal is
    // supported by measurable model rain, multiple wet race-window hours, or
    // more than one wet source, promote the call to NO-GO.
    if(peakPop>=60) decisionRisk=Math.max(decisionRisk,55);
    if(peakPop>=60&&(s.total>=.05||s.wetHours>=2||wetSourceCount>=2)){
      decisionRisk=Math.max(decisionRisk,65);
    }

    const[v,c]=verdict(decisionRisk);
    $('statusCard').className='status-card card '+c;
    $('decisionText').textContent=v;
    $('riskScore').textContent=decisionRisk;
    $('peakPop').textContent=Math.round(peakPop)+'%';
    $('rainTotal').textContent=s.total.toFixed(2)+' in';
    $('dryingIndex').textContent=s.drying+'/100';
    $('confidenceText').textContent=conf;
    const maxWind=Math.max(...s.rows.map(r=>r.wind)),maxGust=Math.max(...s.rows.map(r=>r.gust));
    $('windText').textContent=Math.round(maxWind)+' G'+Math.round(maxGust)+' mph';
    const noon=s.rows.find(r=>r.time.slice(11,13)==='12')||s.rows[0];
    const da=noon?calcDA(noon.temp,noon.rh,noon.pressure):null;
    $('daText').textContent=da==null?'--':da.toLocaleString()+' ft';
    const rainStart=s.rows.find(r=>r.rain>=.01||r.pop>=60);
    $('summaryText').textContent=
      (rainStart?'Main weather concern begins around '+fmtTime(rainStart.time)+'. ':'No strong rain signal in the 7 AM–7 PM race window. ')+
      consensusLabel(modelResults,n)+'. '+
      (s.total>=.25?'Model-average rainfall is substantial for a dragstrip. ':'')+
      'NWS peak rain chance is '+n.peak+'%; accuracy-weighted model peak is '+Math.round(s.peak)+'%.';
    $('hourlyBody').innerHTML=s.rows.map(r=>{
      const daHr=calcDA(r.temp,r.rh,r.pressure);
      return '<tr><td>'+fmtTime(r.time)+'</td><td>'+Math.round(r.pop)+'%</td><td>'+r.rain.toFixed(2)+'"</td><td>'+Math.round(r.temp)+'°</td><td>'+Math.round(r.rh)+'%</td><td>'+Math.round(r.wind)+' G'+Math.round(r.gust)+'</td><td>'+(daHr==null?'--':daHr.toLocaleString())+'</td></tr>';
    }).join('');
    const modelHtml=modelResults.map(m=>{
      const hist=skillWeights[m.id]||{};
      const weight=Math.round((hist.weight??(1/modelResults.length))*100);
      const skill=Number.isFinite(hist.skill)?' · '+hist.skill+'/100 recent rain skill':' · equal fallback weight';
      return '<div class="source-row"><div><strong>'+m.label+'</strong><small>'+m.total.toFixed(2)+'" model rainfall · '+weight+'% model weight'+skill+'</small></div><span class="badge">'+Math.round(m.peak)+'% peak</span></div>';
    }).join('');
    $('sourceList').innerHTML=
      '<div class="source-row"><div><strong>NWS</strong><small>'+(n.summary||'Official hourly point forecast')+'</small></div><span class="badge">'+n.peak+'% peak</span></div>'+modelHtml;
    $('lastUpdated').textContent='Updated '+new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  }catch(e){
    errorBox.hidden=false;
    errorBox.textContent=e.message+' — try Refresh in a moment.';
    $('decisionText').textContent='Weather unavailable';
  }
}
init();