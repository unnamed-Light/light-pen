LightPen.register({
  async ideas(args) {
    if (!Number.isInteger(args.count)) throw Error('Количество должно быть целым');
    const elements = Array.from({ length: args.count }, (_, i) => ({
      kind: 'sticky', x: 160 + (i % 3) * 260, y: 160 + Math.floor(i / 3) * 190,
      width: 230, height: 160, fill: args.color, text: args.title + ' ' + (i + 1),
    }));
    return LightPen.board.apply({ create: elements, label: 'Идеи расширения' });
  },
  async counter(args) {
    return LightPen.widgets.create({ type: 'counter', data: { title: args.title, value: args.value },
      fallback: args.title + '\n' + args.value, x: 200, y: 180, width: 280, height: 180 });
  },
  async increment() {
    const widgets = [];let offset = 0;
    do {
      const board = await LightPen.board.read({ selectionOnly: true, offset, limit: 200 });
      widgets.push(...board.elements.filter(e => e.widget?.pluginId === 'lightpen.ideas' && e.widget.type === 'counter'));
      offset = board.next;
    } while (offset !== null);
    if (!widgets.length) throw Error('Сначала выберите карточку счётчика на доске');
    return LightPen.board.apply({ update: widgets.map(e => {
      const data = { ...e.widget.data, value: Number(e.widget.data.value) + 1 };
      const fallback = data.title + '\n' + data.value;
      return { id: e.id, patch: { widget: { ...e.widget, data, fallback }, text: fallback } };
    }), label: 'Увеличение счётчика' });
  },
  async summary() {
    const board = await LightPen.board.read();
    const result = { objects: board.total, widgets: board.widgetCount };
    await LightPen.ui.notify('Объектов: ' + result.objects + ', виджетов: ' + result.widgets);
    return result;
  },
});
