/** 单次送入视觉模型的图片上限，控制 token 与请求体大小。
 *  intent / judges / orchestrator 三处共用，避免各自定义漂移。 */
export const MAX_IMAGES = 4;
