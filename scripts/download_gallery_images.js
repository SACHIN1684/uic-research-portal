const fs = require('fs');
const path = require('path');
const https = require('https');

const galleryDir = path.join(__dirname, '..', 'public', 'images', 'gallery');
const facultyDir = path.join(__dirname, '..', 'public', 'images', 'faculty');

if (!fs.existsSync(galleryDir)) fs.mkdirSync(galleryDir, { recursive: true });
if (!fs.existsSync(facultyDir)) fs.mkdirSync(facultyDir, { recursive: true });

// Curated high-res Unsplash photo URLs for academic awards, conferences, innovation, hackathons, and headshots
const galleryImages = [
  {
    name: 'award_ceremony_1.jpg',
    url: 'https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&w=800&q=80' // stage award ceremony
  },
  {
    name: 'faculty_felicitation_2.jpg',
    url: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=800&q=80' // conference convention award
  },
  {
    name: 'conference_hall_3.jpg',
    url: 'https://images.unsplash.com/photo-1475721027785-f74eccf877e2?auto=format&fit=crop&w=800&q=80' // keynote presentation
  },
  {
    name: 'patent_innovation_4.jpg',
    url: 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?auto=format&fit=crop&w=800&q=80' // tech lab innovation
  },
  {
    name: 'hackathon_winners_5.jpg',
    url: 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=800&q=80' // hackathon collaboration
  },
  {
    name: 'symposium_panel_6.jpg',
    url: 'https://images.unsplash.com/photo-1524178232363-1fb2b075b655?auto=format&fit=crop&w=800&q=80' // seminar workshop
  },
  {
    name: 'accreditation_celebration_7.jpg',
    url: 'https://images.unsplash.com/photo-1523580494863-6f3031224c94?auto=format&fit=crop&w=800&q=80' // academic celebration graduation honor
  },
  {
    name: 'robotics_lab_8.jpg',
    url: 'https://images.unsplash.com/photo-1485827404703-89b55fcc595e?auto=format&fit=crop&w=800&q=80' // robotics prototype research
  }
];

const facultyImages = [
  {
    name: 'faculty_prabhjot.jpg',
    url: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=400&q=80' // professional female professor
  },
  {
    name: 'faculty_sachin.jpg',
    url: 'https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=400&q=80' // professional male researcher
  },
  {
    name: 'faculty_anika.jpg',
    url: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&w=400&q=80' // professional female academic
  },
  {
    name: 'faculty_sumit.jpg',
    url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80' // professional academic headshot
  },
  {
    name: 'faculty_gagandeep.jpg',
    url: 'https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&w=400&q=80' // female professor
  },
  {
    name: 'faculty_maajid.jpg',
    url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=400&q=80' // male professor
  },
  {
    name: 'faculty_mandeep.jpg',
    url: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=400&q=80' // male academic
  },
  {
    name: 'faculty_renu.jpg',
    url: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=400&q=80' // female researcher
  }
];

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed with HTTP status ${res.statusCode}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(destPath));
      });
      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('Downloading gallery images...');
  for (const item of galleryImages) {
    const dest = path.join(galleryDir, item.name);
    try {
      await downloadFile(item.url, dest);
      console.log('Downloaded gallery:', item.name);
    } catch (e) {
      console.error('Failed gallery:', item.name, e.message);
    }
  }

  console.log('Downloading faculty portrait images...');
  for (const item of facultyImages) {
    const dest = path.join(facultyDir, item.name);
    try {
      await downloadFile(item.url, dest);
      console.log('Downloaded faculty:', item.name);
    } catch (e) {
      console.error('Failed faculty:', item.name, e.message);
    }
  }
  console.log('Done!');
}

run();
