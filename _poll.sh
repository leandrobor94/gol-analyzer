#!/bin/bash
cd "C:/Users/nitro 5034/Desktop/Nueva carpeta/gol-analyzer"
T=$(git config --get remote.origin.url | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
dump(){ curl -sL -H "Authorization: Bearer $T" "https://api.github.com/repos/leandrobor94/gol-analyzer/actions/runs/$1/logs" -o "R$1.zip" 2>/dev/null
python -c "
import zipfile,re,sys
z=zipfile.ZipFile('R$1.zip')
for n in sorted(z.namelist()):
    t=z.read(n).decode('utf8','ignore')
    if 'casos con' in t or 'apuestas resueltas' in t:
        for l in t.split(chr(10)):
            if any(k in l for k in ['casos con','respuestas validas','motivos','===','media ','desviacion','CORRELACION','MAE','VEREDICTO','insuficiente','apuestas resueltas','juzgadas','SIN filtro','aprobadas','rechazadas','tasa de rechazo','APORTE']): print(re.sub(r'^\S+Z ','',l)[:230])
"; }
# esperar al run en curso
for i in $(seq 1 90); do
  S=$(curl -s -H "Authorization: Bearer $T" "https://api.github.com/repos/leandrobor94/gol-analyzer/actions/runs/31230045962" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(r.status)})")
  [ "$S" = "completed" ] && break
  sleep 30
done
echo "===== RUN 1 (contexto) ====="; dump 31230045962
curl -s -X POST -H "Authorization: Bearer $T" "https://api.github.com/repos/leandrobor94/gol-analyzer/actions/workflows/test-ctx.yml/dispatches" -d '{"ref":"main"}' >/dev/null
sleep 40
ID=$(curl -s -H "Authorization: Bearer $T" "https://api.github.com/repos/leandrobor94/gol-analyzer/actions/workflows/test-ctx.yml/runs?per_page=1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).workflow_runs[0].id)})")
for i in $(seq 1 160); do
  S=$(curl -s -H "Authorization: Bearer $T" "https://api.github.com/repos/leandrobor94/gol-analyzer/actions/runs/$ID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(r.status)})")
  [ "$S" = "completed" ] && break
  sleep 30
done
echo "===== RUN 2 (contexto + filtro) run=$ID ====="; dump $ID
