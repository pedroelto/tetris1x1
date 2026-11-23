// Emissor de eventos mínimo (funciona no navegador e no Node).
// A engine usa isto para avisar "o que aconteceu" sem saber quem está ouvindo:
// hoje quem ouve é a interface; nas próximas fases será o socket.

export class Emitter {
  constructor() {
    this.listeners = {};
  }

  on(eventName, callback) {
    (this.listeners[eventName] ??= []).push(callback);
  }

  emit(eventName, data) {
    for (const callback of this.listeners[eventName] ?? []) callback(data);
  }
}
