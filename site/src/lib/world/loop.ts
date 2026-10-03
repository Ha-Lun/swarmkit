// The homecoming camera (the page loops, see motion-config LOOP_VH): from the finale's end pose back to the intro's rest pose. Like the walk's dive, the direction turns about the globe
// centre (slerp) while the distance and the look-at target are lerped, so the camera never cuts through the globe on the way.
import { Quaternion, Vector3 } from 'three';

const da = new Vector3(), db = new Vector3(), qFull = new Quaternion(), qPart = new Quaternion(), ident = new Quaternion();

/** `posA`/`targetA` (the finale pose) are blended towards `posB`/`targetB` (the intro's rest pose) by `w`, in place into `posA`/`targetA`. */
export function loopCameraPose(posA: Vector3, targetA: Vector3, posB: Vector3, targetB: Vector3, w: number): void {
  const la = posA.length(), lb = posB.length();
  da.copy(posA).divideScalar(la);
  db.copy(posB).divideScalar(lb);
  qFull.setFromUnitVectors(da, db);
  qPart.copy(ident).slerp(qFull, w);
  posA.copy(da.applyQuaternion(qPart)).multiplyScalar(la + (lb - la) * w);
  targetA.lerp(targetB, w);
}
