# Dojo

Simulador de trading de memecoins da Solana: saldo de mentira (US$ 10.000), **moedas reais com preços simulados**.
Sem carteira, sem login, sem dependências, sem build (Node 12+).

    node src/server.js        # http://127.0.0.1:3100
    npm test                  # testes do app + testes estatísticos do simulador, sem rede

## Mercado simulado (importante)
Os tokens são reais (nome, ícone, liquidez, tamanho, variações reais de 5m/1h/6h/24h, vindos do DexScreener), mas **os preços
são gerados pelo servidor** (`src/world.js`), uma vez por segundo, em memória. Por isso os gráficos nunca congelam e o treino
não depende do limite das APIs gratuitas. A tela avisa que os preços são simulados (selo SIM, rodapé e título da home).

Como o preço se move (em log, passos de 1 s):
- **Âncora real**: puxa devagar (~10 min) para o preço real, que é relido a cada minuto. A simulação segue a tendência real.
- **Vida própria**: um desvio lento (~1 h) ao redor do preço real.
- **Ruído com volatilidade por token**: poços pequenos e pares novos são muito mais voláteis que tokens grandes e antigos
  (a volatilidade por minuto sai da liquidez, da idade e dos movimentos reais recentes).
- **Regimes**: calmo / normal / euforia. A euforia é um pump ou dump com deriva, e costuma devolver parte depois.
- **Saltos** de cauda pesada (Pareto), com viés para baixo em poços finos. Os retornos têm curtose bem acima de 3.
- **Volume** sobe com o tamanho do movimento; compras e vendas seguem a direção; a liquidez varia com o preço como num AMM.
- **Histórico de 24 h** de cada token nasce como uma ponte browniana pelos pontos reais de 5m/1h/6h/24h.

As ordens dos jogadores **não** mexem no preço do mercado (ele é o mesmo para todos); elas pagam o impacto de preço do poço
só na execução. Não são cotações reais e não servem como dado financeiro.

## Gráfico (estilo terminal profissional)
Página do token com: velas de **1s, 15s, 30s**, 1m a 1D (os segundos vêm de 1 h de ticks por segundo guardados por token);
alternância **MarketCap / Price** no eixo (padrão MarketCap); legenda de duas linhas (O H L C, variação e volume) que
segue o cursor; **setas B/S** nas velas onde você comprou e vendeu; **linha tracejada no preço médio de entrada**, verde ou
vermelha conforme seu PnL; linha pontilhada no preço atual; zoom rápido (5m a 24h), relógio local, escalas `%` e `log`,
`Hide All`. No painel: faixa **5m Vol / Buys / Sells / Net Vol**, bloco **Bought / Sold / Holding / PnL** (PnL = posição + vendido
− comprado, naquele token) e abas Trades / Positions / Info. Preços minúsculos aparecem como `$0.0₅16` (o número pequeno conta
os zeros). As velas são atualizadas a cada 2 s direto da simulação.

## Pulse (lançamentos simulados)
Tela com três colunas ao vivo, no estilo de um terminal de lançamentos: **New Pairs** (acabou de nascer), **Final Stretch**
(perto de migrar) e **Migrated**. Cada cartão mostra avatar com anel de progresso, idade, redes, estatísticas de carteiras
(T10, DEV, SNP, INS, BND), V (volume), MC, NB (compras líquidas) e um botão ⚡ de compra rápida com o valor configurável.
Feito para parecer vivo: nasce um lançamento a cada ~2 s (`LAUNCH_RATE`), a tela atualiza a cada 1 s e só o que mudou é
tocado. Cada cartão tem degradê verde/vermelho pela variação de 5 min que **respira**, números (MC, V, NB) que **rolam** até o
novo valor, um flash na direção em que o market cap andou, um **mini-gráfico** dos últimos 5 min, selos **NEW** (primeiros
20 s), **🚀 MIGRATED** (logo depois de migrar) e **🔥 HOT** (os 15% que mais se mexem, com piso de +10% em 5 min). Cartões novos
entram com brilho e os que já estavam deslizam para o novo lugar. De tempos em tempos alguns cartões do topo "reconstroem" um
número (dígitos embaralham e param no valor verdadeiro). A barra do topo mostra lançados, migrados e lançamentos por minuto.

Os lançamentos (`src/launchpad.js`) são **inventados**: nome, endereço (`...pump`), dev e estatísticas. O destino de cada um é
sorteado no nascimento: **dud** 55% (some), **meh** 25%, **runner** 12% (chega perto) e **graduate** 8% (passa de
US$ 25 mil de market cap e migra: a coluna muda, a corretora vira `pumpswap`, e depois ele sobe ou cai). O roteiro só move
a âncora do preço; o resto (ruído, euforia, saltos, volume, velas, gráfico de 1s) é o mesmo simulador dos outros tokens, então
um lançamento se opera e se vê como qualquer moeda, com o impacto de preço de um poço pequeno. Holders, top 10, dev, snipers
etc. evoluem com o tempo (holders crescem, top 10 e snipers caem, dev pode vender). Na coluna Migrated os graduados simulados
dividem espaço com os tokens reais do mercado (pelo menos 10 vagas para eles). Ao ligar o servidor, os últimos 30 minutos de
lançamentos são simulados de uma vez (`WARMUP_MIN`), para as colunas já nascerem cheias. Os lançamentos que não foram a lugar
algum somem depois de ~25 min (e há um teto de 220 esperando), sem nunca remover quem você tem ou abriu nos últimos 10 min. Quem tem posição num lançamento nunca o perde: ele é salvo em `DATA_DIR/universe.json`.

## Como funciona o resto
- **Jogador**: um id aleatório guardado no navegador (`localStorage`). Dinheiro fictício, então não há login.
- **Execução simulada** (`src/sim.js`): pool de produto constante, R = liquidez/2. Comprar x dólares paga preço médio
  `spot * (1 + x/R)`; vender devolve `x / (1 + x/R)`; mais taxa fixa (`FEE_PCT`, padrão 0,5%).
- **Patrimônio** = caixa + valor de saída das posições (com impacto de preço), para token ilíquido não inflar o ranking.
- **Dados reais** (`src/feed.js`, DexScreener): só no começo, a cada minuto (âncora, em lotes de 30), a cada 3 min (tokens
  novos) e quando alguém abre ou busca um token que ainda não está no mercado. Operar e ver gráfico nunca esperam a rede.
  Se a API cair, a simulação continua; o último mercado fica em `DATA_DIR/universe.json` para reinícios.
- **Persistência**: um arquivo JSON (`DATA_DIR/accounts.json`). Serve para poucos usuários; o próximo passo é um banco.

## Variáveis de ambiente
`PORT`, `HOST`, `DATA_DIR` (disco persistente em produção), `START_CASH` (10000), `FEE_PCT` (0.5), `LAUNCH_RATE` (0.6 por segundo),
`WARMUP_MIN` (30).

## Limites conhecidos
- O mercado é compartilhado e em memória: com 2 instâncias do servidor cada uma teria preços diferentes. Use 1 instância.
- Id de jogador é anônimo: limpar o navegador perde a conta. Ranking aceita apelidos livres (sanitizados).
- Até 160 tokens no mercado; os que alguém segura nunca são removidos.

## Testes
- `node test/run.js`: testes de contas, execução, mercado simulado e API, com o DexScreener simulado (sem rede).
- `node test/world_tests.js`: propriedades estatísticas do simulador (histórico passa pelos pontos reais, volatilidade
  proporcional à liquidez, caudas pesadas, preço limitado em torno do real, volume acompanha os movimentos), com semente fixa.
- `node test/launchpad_tests.js`: ciclo de vida dos lançamentos (endereço válido, destinos sorteados, migração, colunas sem
  repetição, estatísticas que evoluem, limpeza sem apagar quem tem posição, operar um lançamento).
- `test/scenarios_live.js`: 22 cenários de usuário contra servidor real (ver cabeçalho do arquivo). Rodar com pasta de dados limpa.
