// Serialization only. All programme collection/decoding belongs to TVHeadend.
export const EPG_REFRESH_SECONDS = 86400;
const xml = value => String(value ?? '').replace(/[<>&'\"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const xmltvDate = value => new Date(value).toISOString().replace(/[-:]/g, '').replace('.000Z', ' +0000').replace('T', '');
export function xmltv(document) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Astra Linux Control">\n${document.channels.map(channel => `  <channel id="${xml(channel.id)}"><display-name>${xml(channel.name)}</display-name></channel>`).join('\n')}\n${document.programmes.map(event => `  <programme channel="${xml(event.channel)}" start="${xmltvDate(event.start)}" stop="${xmltvDate(event.stop)}"><title>${xml(event.title)}</title>${event.description ? `<desc>${xml(event.description)}</desc>` : ''}</programme>`).join('\n')}\n</tv>\n`;
}
