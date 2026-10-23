# Ninho

Protótipo de diário de sono do bebê inspirado na ideia geral do Napper. Interface e código originais, em português, para uso no navegador do celular ou computador.

## Funcionalidades

- Perfil do bebê e estimativa simples da próxima janela de sono por faixa etária.
- Cronômetro para iniciar e encerrar um descanso.
- Registro manual e exclusão de períodos de sono.
- Resumo do dia, histórico diário e gráfico dos últimos sete dias.
- Dados salvos apenas no `localStorage` do navegador usado. Não há conta nem sincronização entre dispositivos.

Abra `index.html` no navegador para experimentar. Para servir via HTTP, execute `python3 -m http.server 8000` nesta pasta e abra `http://localhost:8000`.

As janelas de sono são estimativas gerais para organização da rotina; não são orientações médicas. O projeto não usa código, marca ou imagens do Napper.
