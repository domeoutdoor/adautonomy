import re, subprocess, sys
src=open('src/adautonomy.html',encoding='utf-8').read()
dist_p='index.html'
dist=open(dist_p,encoding='utf-8').read()
head=dist[:dist.index('<body>')+len('<body>')+1]
tail=dist[dist.rindex('</body>'):]
body=src.replace('<meta name="claude:viewport-fit-sides" content="cover">\n','')
assert 'viewport-fit-sides' not in body
out=head+body+('\n' if not body.endswith('\n') else '')+tail
open(dist_p,'w',encoding='utf-8').write(out)
# syntax check
scripts=re.findall(r'<script(?![^>]*src)[^>]*>([\s\S]*?)</script>',out)
for i,sc in enumerate(scripts):
    p=f'/tmp/s{i}.js'; open(p,'w').write(sc)
    r=subprocess.run(['node','--check',p],capture_output=True,text=True)
    if r.returncode: print(r.stderr); sys.exit(1)
vis=re.sub(r'<script[\s\S]*?</script>','',out); vis=re.sub(r'<style[\s\S]*?</style>','',vis); vis=re.sub(r'<[^>]+>',' ',vis)
bad=re.findall(r'\bAI\b',vis)+re.findall(r'claude',vis,re.I)
print('built', len(out), 'bytes; forbidden words:', bad)
