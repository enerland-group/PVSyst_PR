import { entity, authenticated, uuid, text, int, set } from '@microsoft/rayfin-core';

/**
 * One piece of a compressed project payload (configuration, SCADA, PVsyst or
 * meter data). Payloads are gzip + base64 and split in pieces of up to 4,000
 * characters, because text columns must have a maximum length.
 */
@entity()
@authenticated('*')
export class ProjectChunk {
  @uuid() id!: string;
  @text({ max: 40 }) project_id!: string;
  @set('config', 'scada', 'pvsyst', 'meter') kind!: 'config' | 'scada' | 'pvsyst' | 'meter';
  @int() version!: number;
  @int() seq!: number;
  @int() total!: number;
  @text({ max: 4000 }) data!: string;
}
