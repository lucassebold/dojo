# Dojo

Simulador de trading de memecoins da Solana: saldo de mentira (US$ 10.000), preços e liquidez reais.
Sem carteira, sem login, sem dependências, sem build (Node 12+).

    node src/server.js        # http://127.0.0.1:3100
    node test/run.js          # 11 testes, sem rede

## Como funciona
- **Jogador**: um id aleatório guardado no navegador (`localStorage`). Dinheiro fictício, então não há login.
- **Execução simulada** (`src/sim.js`): pool de produto constante, R = liquidez/2. Comprar x dólares paga preço médio
  `spot * (1 + x/R)`; vender devolve `x / (1 + x/R)`; mais taxa fixa (`FEE_PCT`, padrão 0,5%).
- **Patrimônio** = caixa + valor de saída das posições (com impacto de preço), para token ilíquido não inflar o ranking.
- **Dados** (`src/market.js`): DexScreener (preços, em lotes de 30) e GeckoTerminal (candles, fila com intervalo mínimo).
  Tudo passa por cache compartilhado: o número de chamadas externas depende de quantos TOKENS estão em uso, não de quantas
  pessoas estão online. Se a API falhar, serve a última cópia boa.
- **Persistência**: um arquivo JSON (`DATA_DIR/accounts.json`). Serve para poucos usuários; o próximo passo é um banco.

## Variáveis de ambiente
`PORT`, `HOST`, `DATA_DIR` (disco persistente em produção), `START_CASH` (10000), `FEE_PCT` (0.5), `GECKO_SPACING_MS` (2300).

## Limites conhecidos
- Sem cache = estouro do limite grátis do GeckoTerminal (~30/min). O cache de candles (30 s a 5 min) evita isso.
- Id de jogador é anônimo: limpar o navegador perde a conta. Ranking aceita apelidos livres (sanitizados).
- Atribuição obrigatória: "Charts: GeckoTerminal" está no rodapé.

## Testes
- `node test/run.js`: 13 testes unitarios/API, sem rede.
- `test/scenarios_live.js`: 22 cenarios de usuario contra servidor real (ver cabecalho do arquivo). Deve rodar com pasta de dados limpa.
