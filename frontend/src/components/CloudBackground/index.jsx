/**
 * Static cloud background layer for SkyBao.
 *
 * Renders a single fixed, full-viewport div (`.cloud-bg`) whose background
 * image is the pre-rendered clouds WebP (see public/clouds-{light,dark}.webp).
 * The image is one
 * continuous sky that covers the whole viewport, so translucent UI sections
 * (sidebar / chat / borders) line up seamlessly over it.
 *
 * The WebP already embeds the cloud shapes (procedural blobs warped by an SVG
 * turbulence filter at build time), so there is no runtime SVG-filter or
 * box-shadow cost — it's a plain CSS background image.
 *
 * @param {{ className?: string }} props
 */
export default function CloudBackground({ className = "" }) {
  return <div className={`cloud-bg ${className}`} aria-hidden="true" />;
}
