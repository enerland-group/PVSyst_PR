import { entity, authenticated, uuid, text, int, date, set } from '@microsoft/rayfin-core';

/**
 * A performance-test model (PR or EPI) saved from the Model builder.
 * The configuration and the imported data are stored compressed in
 * ProjectChunk rows; the *Version fields point to the current copy of each.
 * Every signed-in user of the app can see and edit every project.
 */
@entity()
@authenticated('*')
export class Project {
  @uuid() id!: string;
  @text({ max: 200 }) name!: string;
  @text({ max: 40, optional: true }) code?: string;
  @set('EPI', 'PR') testType!: 'EPI' | 'PR';
  @text({ max: 60, optional: true }) country?: string;
  @text({ max: 200, optional: true }) client?: string;
  @text({ max: 40, optional: true }) procedure?: string;
  @text({ max: 60, optional: true }) stage?: string;
  @text({ max: 10, optional: true }) periodStart?: string;
  @text({ max: 10, optional: true }) periodEnd?: string;
  @text({ max: 300, optional: true }) result?: string;
  @int({ default: 0 }) configVersion!: number;
  @int({ default: 0 }) scadaVersion!: number;
  @int({ default: 0 }) pvsystVersion!: number;
  @int({ default: 0 }) meterVersion!: number;
  @text({ max: 200, optional: true }) updatedBy?: string;
  @date() createdAt!: Date;
  @date() updatedAt!: Date;
}
