"use client";
import React, { useState } from "react";
import { motion } from "motion/react";

export interface GalleryPhoto {
  id: string | number;
  image: string;
  /** Shown on the card, e.g. "Front". */
  label?: string;
}

const defaultPhotos: GalleryPhoto[] = [
  { id: 1, image: "https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=900&q=70&auto=format&fit=crop", label: "Front" },
  { id: 2, image: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=900&q=70&auto=format&fit=crop" },
  { id: 3, image: "https://images.unsplash.com/photo-1484154218962-a197022b5858?w=900&q=70&auto=format&fit=crop" },
  { id: 4, image: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?w=900&q=70&auto=format&fit=crop" },
  { id: 5, image: "https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=900&q=70&auto=format&fit=crop" },
];

export interface InteractiveFolderGalleryProps {
  /** In display order: the first photo is the cover and sits on top of the stack. */
  photos?: GalleryPhoto[];
  folderName?: string;
  dragHintText?: string;
  className?: string;
  /** "sm" fits a record rail; "md" is the original showcase size. */
  size?: "sm" | "md";
  /** When set, clicking an open card calls this with the photo's index in `photos`. */
  onPhotoClick?: (index: number) => void;
}

/** Manila folder stock — tab, body, flap. */
const MANILA = {
  tab: "linear-gradient(to top, #d9b56a, #e8c98a)",
  back: "linear-gradient(to bottom, #e2c17a, #c9a45c)",
  front: "linear-gradient(to bottom, #f0d9a8, #d9b56a)",
  edge: "rgba(120, 90, 40, .28)",
  labelBg: "rgba(255,248,230,.92)",
  labelText: "#5c4a28",
  highlight: "rgba(255,255,255,.45)",
} as const;
const SIZES = {
  md: {
    wrapH: 500, wrapW: 400, backW: 320, backH: 224, tabW: 128, tabH: 40,
    cardW: 224, cardH: 288, frontW: 340, frontH: 176,
    spread: 130, lift: -130, fan: 30, labelPad: 32, hintSize: 13,
  },
  sm: {
    wrapH: 168, wrapW: 220, backW: 188, backH: 118, tabW: 72, tabH: 22,
    cardW: 96, cardH: 120, frontW: 200, frontH: 72,
    spread: 36, lift: -48, fan: 14, labelPad: 14, hintSize: 10,
  },
} as const;

export function InteractiveFolderGallery({
  photos = defaultPhotos,
  folderName = "Photography.gallery",
  dragHintText = "Drag any photo down to close",
  className,
  size = "md",
  onPhotoClick,
}: InteractiveFolderGalleryProps) {
  const [isFolderOpen, setIsFolderOpen] = useState(false);
  const [hoverFolder, setHoverFolder] = useState(false);
  const [broken, setBroken] = useState<Record<string, true>>({});
  const z = SIZES[size];
  // Drop failed loads so expired COMPR tokens do not fan identical blank tiles.
  const live = photos.filter((p) => p.image && !broken[String(p.id)]);
  const shown = (live.length ? live : photos.slice(0, 1)).slice(0, 5);
  const order = shown.map((_, i) => i).reverse();

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        maxWidth: z.wrapW,
        height: z.wrapH,
        margin: "0 auto",
        flex: "none",
      }}
    >
      <div style={{ position: "relative", width: "100%", height: "100%" }}>

        {/* Folder back + tab */}
        <motion.div
          style={{
            position: "absolute", left: "50%", bottom: 10, width: z.backW, height: z.backH,
            marginLeft: -z.backW / 2, pointerEvents: "none",
          }}
          animate={{ opacity: isFolderOpen ? 0 : 1, scale: isFolderOpen ? 0.94 : 1 }}
        >
          <div style={{
            position: "absolute", top: 0, left: 0, width: z.tabW, height: z.tabH,
            borderRadius: "10px 10px 0 0",
            background: MANILA.tab,
            borderTop: `1px solid ${MANILA.edge}`,
            borderLeft: `1px solid ${MANILA.edge}`,
            borderRight: `1px solid ${MANILA.edge}`,
          }} />
          <div style={{
            position: "absolute", top: z.tabH - 2, left: 0, right: 0, bottom: 0,
            borderRadius: "0 12px 12px 12px",
            background: MANILA.back,
            border: `1px solid ${MANILA.edge}`,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,.35), 0 8px 20px rgba(90,60,20,.18)",
          }} />
        </motion.div>

        {/* Photo stack */}
        <div style={{
          position: "absolute", left: "50%", bottom: size === "sm" ? 28 : 40,
          width: 0, height: 0, zIndex: 10, display: "flex", justifyContent: "center",
        }}>
          {order.map((i, depth) => {
            const photo = shown[i];
            const offset = i === 0 ? 0 : (i % 2 ? -1 : 1) * Math.ceil(i / 2);
            const stackY = hoverFolder ? Math.abs(offset) * 8 - 28 : Math.abs(offset) * 4;
            const stackX = hoverFolder ? offset * z.fan : offset * 3;
            const stackRotate = hoverFolder ? offset * 7 : offset * 2.5;
            const stackScale = 1 - Math.abs(offset) * 0.03;
            const openX = offset * z.spread;

            return (
              <motion.div
                key={photo.id}
                drag={isFolderOpen}
                dragSnapToOrigin
                onDragEnd={(_e, info) => {
                  if (info.offset.y > 80 && isFolderOpen) {
                    setIsFolderOpen(false);
                    setHoverFolder(false);
                  }
                }}
                // The caller's index: broken tiles are dropped from `shown`, not from `photos`.
                onTap={() => { if (isFolderOpen && onPhotoClick) onPhotoClick(photos.indexOf(photo)); }}
                style={{
                  position: "absolute",
                  bottom: 0,
                  left: -z.cardW / 2,
                  width: z.cardW,
                  height: z.cardH,
                  borderRadius: 12,
                  overflow: "hidden",
                  border: "1px solid rgba(120,90,40,.2)",
                  background: "#f5f0e6",
                  boxShadow: "0 10px 22px rgba(90,60,20,.22)",
                  transformOrigin: "bottom center",
                  cursor: isFolderOpen ? "grab" : "default",
                  pointerEvents: isFolderOpen ? "auto" : "none",
                }}
                animate={!isFolderOpen ? {
                  y: stackY, x: stackX, rotate: stackRotate, scale: stackScale, zIndex: depth + 10,
                } : {
                  y: z.lift, x: openX, rotate: 0, scale: 1.04, zIndex: i === 0 ? 60 : 50 - Math.abs(offset),
                }}
                whileHover={isFolderOpen ? { scale: 1.08, zIndex: 100 } : {}}
                whileDrag={isFolderOpen ? { scale: 1.1, rotate: 4, zIndex: 150 } : {}}
                transition={{ type: "spring", stiffness: 350, damping: 30 }}
              >
                <img
                  src={photo.image}
                  alt={photo.label || "Property photo"}
                  style={{ width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }}
                  draggable={false}
                  onError={() => setBroken((b) => ({ ...b, [String(photo.id)]: true }))}
                />
                {photo.label ? (
                  <span style={{
                    position: "absolute", top: 6, left: 6, padding: "2px 7px", borderRadius: 999,
                    background: "rgba(0,0,0,.72)", color: "#fff", fontSize: 9, fontWeight: 700,
                    letterSpacing: ".04em", textTransform: "uppercase",
                  }}>{photo.label}</span>
                ) : null}
              </motion.div>
            );
          })}
        </div>

        {/* Folder front flap */}
        <motion.div
          style={{
            position: "absolute", left: "50%", bottom: 0, width: z.frontW, height: z.frontH,
            marginLeft: -z.frontW / 2, transformOrigin: "bottom center",
            cursor: "pointer", zIndex: 20, pointerEvents: isFolderOpen ? "none" : "auto",
          }}
          animate={{
            opacity: isFolderOpen ? 0 : 1,
            rotateX: hoverFolder ? -22 : 0,
            y: hoverFolder ? 6 : 0,
          }}
          onMouseEnter={() => setHoverFolder(true)}
          onMouseLeave={() => setHoverFolder(false)}
          onClick={() => setIsFolderOpen(true)}
          role="button"
          aria-label={`Open ${folderName}`}
        >
          <div style={{
            width: "100%", height: "100%",
            background: MANILA.front,
            borderRadius: 14, border: `1px solid ${MANILA.edge}`,
            boxShadow: "inset 0 2px 6px rgba(255,255,255,.4), 0 -8px 22px rgba(90,60,20,.2)",
            display: "flex", alignItems: "flex-end", justifyContent: "center",
            paddingBottom: z.labelPad, position: "relative", overflow: "hidden",
          }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(to right, transparent, ${MANILA.highlight}, transparent)` }} />
            <div style={{
              padding: size === "sm" ? "5px 10px" : "8px 16px",
              background: MANILA.labelBg, borderRadius: 8, border: `1px solid ${MANILA.edge}`,
              maxWidth: "90%",
            }}>
              <span style={{
                color: MANILA.labelText, fontSize: size === "sm" ? 11 : 13,
                fontWeight: 600, letterSpacing: ".02em",
                display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {folderName}
              </span>
            </div>
          </div>
        </motion.div>

        <motion.div
          animate={{ opacity: isFolderOpen ? 1 : 0, y: isFolderOpen ? 0 : 24 }}
          style={{
            position: "absolute", left: "50%", bottom: 4, transform: "translateX(-50%)",
            padding: size === "sm" ? "3px 8px" : "6px 14px",
            borderRadius: 999, background: "rgba(0,0,0,.06)",
            border: "1px solid rgba(0,0,0,.08)",
            color: "rgba(0,0,0,.45)", fontSize: z.hintSize, fontWeight: 500,
            letterSpacing: ".08em", textTransform: "uppercase",
            whiteSpace: "nowrap", pointerEvents: "none",
          }}
        >
          {dragHintText}
        </motion.div>
      </div>
    </div>
  );
}

export { InteractiveFolderGallery as Component };
