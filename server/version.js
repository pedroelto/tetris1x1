// Versão do build, para confirmar qual código está no ar.
// O Render define RENDER_GIT_COMMIT com o hash do commit implantado;
// localmente não existe, e a versão aparece como "dev".

export const BUILD_VERSION = (process.env.RENDER_GIT_COMMIT ?? '').slice(0, 7) || 'dev';
