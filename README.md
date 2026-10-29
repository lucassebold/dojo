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
`PORT`, `HOST`, `DATA_DIR` (disco persistente em produção), `START_CASH` (10000), `FEE_PCT` (0.5).

## Limites conhecidos
- O mercado é compartilhado e em memória: com 2 instâncias do servidor cada uma teria preços diferentes. Use 1 instância.
- Id de jogador é anônimo: limpar o navegador perde a conta. Ranking aceita apelidos livres (sanitizados).
- Até 160 tokens no mercado; os que alguém segura nunca são removidos.

## Testes
- `node test/run.js`: testes de contas, execução, mercado simulado e API, com o DexScreener simulado (sem rede).
- `node test/world_tests.js`: propriedades estatísticas do simulador (histórico passa pelos pontos reais, volatilidade
  proporcional à liquidez, caudas pesadas, preço limitado em torno do real, volume acompanha os movimentos), com semente fixa.
- `test/scenarios_live.js`: 22 cenários de usuário contra servidor real (ver cabeçalho do arquivo). Rodar com pasta de dados limpa.
