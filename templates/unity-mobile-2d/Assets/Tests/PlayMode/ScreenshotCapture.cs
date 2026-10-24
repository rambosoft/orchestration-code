using System.Collections.Generic;
using System.IO;
using NUnit.Framework;
using UnityEngine;

namespace Game.Tests
{
    /// <summary>
    /// Screenshot evidence for reviews. `unity test` runs in batch mode where WaitForEndOfFrame never fires, so a camera is rendered to a
    /// RenderTexture and read back. PNGs go to Logs/screenshots, which the orchestrator copies to the reviewer.
    /// </summary>
    public static class ScreenshotCapture
    {
        /// <summary>Number of distinct colours in a sample of the image (stops counting at 64).</summary>
        public static int DistinctColors(Texture2D texture)
        {
            var pixels = texture.GetPixels32();
            var seen = new HashSet<int>();
            for (var i = 0; i < pixels.Length && seen.Count <= 64; i += 5) seen.Add((pixels[i].r << 16) | (pixels[i].g << 8) | pixels[i].b);
            return seen.Count;
        }

        public static string Save(Camera camera, string name, int width = 540, int height = 960)
        {
            var directory = Path.Combine(Path.GetDirectoryName(Application.dataPath) ?? ".", "Logs", "screenshots");
            Directory.CreateDirectory(directory);
            var target = new RenderTexture(width, height, 24);
            var previousTarget = camera.targetTexture;
            var previousActive = RenderTexture.active;
            try
            {
                camera.targetTexture = target;
                camera.Render();
                RenderTexture.active = target;
                var texture = new Texture2D(width, height, TextureFormat.RGB24, false);
                texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                texture.Apply();
                // A screenshot of nothing is not evidence: the first live game run published a blank frame as the proof of a finished screen.
                var distinct = DistinctColors(texture);
                Assert.Greater(distinct, 12, $"screenshot '{name}' is blank or nearly blank ({distinct} distinct colours): render the real screen before capturing it");
                var path = Path.Combine(directory, name + ".png");
                File.WriteAllBytes(path, texture.EncodeToPNG());
                Object.Destroy(texture);
                return path;
            }
            finally
            {
                camera.targetTexture = previousTarget;
                RenderTexture.active = previousActive;
                target.Release();
                Object.Destroy(target);
            }
        }
    }
}
