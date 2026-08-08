#!/bin/bash
cd "C:/Users/nitro 5034/Desktop/Nueva carpeta/gol-analyzer"
T=$(git config --get remote.origin.url | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
curl -s -X POST -H "Authorization: Bearer $T" "https://api.github.com/repos/leandrobor94/gol-analyzer/actions/workflows/test-ctx.yml/dispatches" -d '{"ref":"main"}' >/dev/null
sleep 40
ID=$(curl -s -H "Authorization: Bearer $T" "https://api.github.com/repos/leandrobor94/gol-analyzer/actions/workflows/test-ctx.yml/runs?per_page=1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).workflow_runs[0].id))")
echo "run=$ID"
for i in $(seq 1 200); do
  S=$(curl -s -H "Authorization: Bearer $T" "https://api.github.com/repos/leandrobor94/gol-analyzer/actions/runs/$ID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(r.status+'|'+(r.conclusion||''))})")
  case "$S" in completed*) echo "estado: $S"; break;; esac
  sleep 30
done
curl -sL -H "Authorization: Bearer $T" "https://api.github.com/repos/leandrobor94/gol-analyzer/actions/runs/$ID/logs" -o "RF.zip"
python -c "
import zipfile,re
z=zipfile.ZipFile('RF.zip')
seen=set()
for n in sorted(z.namelist()):
    t=z.read(n).decode('utf8','ignore')
    if 'casos con' in t or 'apuestas resueltas' in t:
        for l in t.split(chr(10)):
            s=re.sub(r'^\S+Z ','',l).rstrip()
            if s and not s.startswith('##[') and s not in seen and any(k in s for k in ['casos con','respuestas validas','motivos','===','media ','desviacion','CORRELACION','MAE','VEREDICTO','insuficiente','apuestas resueltas','juzgadas','SIN filtro','aprobadas','rechazadas','tasa de rechazo','APORTE','/95','Error']):
                seen.add(s); print(s[:235])
"
