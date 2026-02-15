/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Env {
	ALBUM_URL?: string;
	ALLOW_ORIGIN?: string;
	CACHE_CONTROL?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		switch (request.method) {
			case 'GET':
				return handleGet(request, env);
			case 'OPTIONS':
				return handleOptions(env);
			default:
				return new Response(null, { status: 405 });
		}
	},
};

const handleGet = async (request: Request, env: Env): Promise<Response> => {
	// Coba ambil dari query parameter dulu
	const url = new URL(request.url);
	let albumUrl = url.searchParams.get('url')?.trim();
	
	// Kalo ga ada parameter url, pake env variable
	if (!albumUrl) {
		albumUrl = env.ALBUM_URL?.trim();
	}
	
	// Handle kalo user masukin short code aja (7QzAnueaCVnrQdiG7)
	if (albumUrl && !albumUrl.startsWith('http')) {
		// Asumsinya ini short code dari photos.app.goo.gl
		albumUrl = `https://photos.app.goo.gl/${albumUrl}`;
	}

	if (!albumUrl) {
		return jsonResponse(
			{ error: 'ALBUM_URL not set. Provide ?url= parameter or set env variable' }, 
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}

	try {
		// Fetch dengan follow redirect (short link bakal di-redirect ke URL panjang)
		const resp = await fetch(`${albumUrl}?_imcp=1`, { 
			redirect: 'follow',
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			}
		});
		
		if (!resp.ok) {
			return jsonResponse(
				{ error: `Failed to fetch album: ${resp.status}` }, 
				{ status: 502, allowOrigin: env.ALLOW_ORIGIN }
			);
		}
		
		const text = await resp.text();

		// Regex untuk ambil data gambar/video
		const imageMatches = [
			...text.matchAll(
				/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)",(\d+),(\d+)[^\]]+\][^\]]+\]\],(\d+),[^,]+,[^,]+,(\d+)/g,
			),
		];
		
		// Regex yang lebih fleksibel untuk ambil nama file
		// Coba berbagai pattern yang mungkin muncul
		const filenamePatterns = [
			// Pattern dari contoh: <div class="R9U8ab" aria-label="Nama file: JoatPno 03.mp4">JoatPno 03.mp4</div>
			/<div class="R9U8ab"[^>]*aria-label="Nama file:\s*([^"]+)"[^>]*>([^<]+)<\/div>/g,
			
			// Pattern tanpa aria-label
			/<div class="R9U8ab"[^>]*>([^<]+)<\/div>/g,
			
			// Pattern dengan atribut lain
			/<div[^>]*class="[^"]*R9U8ab[^"]*"[^>]*>([^<]+)<\/div>/g,
			
			// Pattern dari data atribut
			/<div[^>]*data-original-filename="([^"]+)"[^>]*>/g,
			
			// Pattern generic buat file name di div
			/<div[^>]*>(?:[^<]*?)([^<>]+\.(?:jpg|jpeg|png|gif|mp4|mov|avi|heic))[^<]*<\/div>/gi
		];

		// Kumpulin semua filename yang ketemu
		let allFilenames: string[] = [];
		for (const pattern of filenamePatterns) {
			const matches = [...text.matchAll(pattern)];
			if (matches.length > 0) {
				// Ambil dari capture group yang ada isinya
				allFilenames = matches.map(m => {
					// Cari capture group yang bukan undefined dan bukan tag HTML
					for (let i = 1; i < m.length; i++) {
						if (m[i] && !m[i].includes('<') && !m[i].includes('>')) {
							return m[i].trim();
						}
					}
					return null;
				}).filter(Boolean) as string[];
				
				if (allFilenames.length > 0) break;
			}
		}

		// Gabungkan data gambar dengan nama file
		const images = imageMatches.map(([, url, width, height, createdTimestamp, updatedTimestamp], index) => {
			// Cari nama file yang sesuai (kalau ada)
			const filename = allFilenames[index] || null;
			
			// Log buat debugging (bisa dihapus nanti)
			console.log(`Image ${index}:`, { url, filename });
			
			return {
				url,
				width: Number(width),
				height: Number(height),
				createdTimestamp: Number(createdTimestamp),
				updatedTimestamp: Number(updatedTimestamp),
				filename: filename,
			};
		}).filter(img => img.url);

		// Deduplikasi berdasarkan URL
		const deduplicated = [...new Map(images.map((image) => [image.url, image])).values()];
		
		// Debug: cek apakah filenamePatterns ada yang match
		const debug = {
			totalMatches: imageMatches.length,
			filenamesFound: allFilenames.length,
			firstFewChars: text.substring(0, 500) // Buat liat struktur HTML
		};
		
		return jsonResponse(
			{ 
				images: deduplicated, 
				count: deduplicated.length,
				albumUrl: albumUrl,
				debug: debug // Sementara buat debug, nanti bisa dihapus
			},
			{
				status: 200,
				allowOrigin: env.ALLOW_ORIGIN,
				extraHeaders: { 
					'Cache-Control': env.CACHE_CONTROL || 'max-age=604800, stale-while-revalidate' 
				},
			}
		);
	} catch (error: any) {
		return jsonResponse(
			{ error: `Failed to process album: ${error.message}` }, 
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}
};

const jsonResponse = (data: any, params: { status?: number; allowOrigin?: string; extraHeaders?: Record<string, string> }) => {
	return new Response(JSON.stringify(data), {
		status: params.status || 200,
		headers: { 
			'content-type': 'application/json', 
			'Access-Control-Allow-Origin': params.allowOrigin || '*', 
			...params.extraHeaders 
		},
	});
};

const handleOptions = async (env: Env): Promise<Response> => {
	return new Response(null, {
		status: 204,
		headers: {
			Allow: 'GET, OPTIONS',
			'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Max-Age': '86400',
		},
	});
};
