# Firestore Database Structure for ReelVotes

## Collections

### 1. `movies` Collection
Contains all movies available for voting.

**Document Schema:**
```javascript
{
  title: "Parasite",           // Movie title
  tmdb_id: 496243,             // TMDB API ID
  year: 2019,                  // Release year
  director: "Bong Joon-ho",    // Director name
  actors: "Song Kang-ho, Lee Sun-kyun, Cho Yeo-jeong",  // Cast
  vote_count: 45,              // Total votes for this movie
  active: true,                // Whether movie is in current voting
  created_at: "2024-03-21",    // Creation date
  updated_at: "2024-03-21"     // Last updated date
}
```

**Example Documents:**
```
movies/
├── movie1 {title: "Oldboy", tmdb_id: 4306, vote_count: 45, active: true, ...}
├── movie2 {title: "Kill Bill", tmdb_id: 7, vote_count: 72, active: true, ...}
├── movie3 {title: "Parasite", tmdb_id: 496243, vote_count: 89, active: true, ...}
└── movie4 {title: "The Thing", tmdb_id: 8564, vote_count: 67, active: true, ...}
```

### 2. `votes` Collection
Records individual votes for analytics and audit trail.

**Document Schema:**
```javascript
{
  movie_id: "movie3",                    // Reference to movie document ID
  movie_title: "Parasite",               // Movie title (for quick access)
  tmdb_id: 496243,                       // TMDB ID
  timestamp: Timestamp,                  // Full timestamp
  vote_date: "2024-03-21"                // Date in YYYY-MM-DD format
}
```

**Example Documents:**
```
votes/
├── vote1 {movie_id: "movie3", movie_title: "Parasite", timestamp: ..., vote_date: "2024-03-21"}
├── vote2 {movie_id: "movie3", movie_title: "Parasite", timestamp: ..., vote_date: "2024-03-21"}
└── vote3 {movie_id: "movie1", movie_title: "Oldboy", timestamp: ..., vote_date: "2024-03-21"}
```

## Firestore Security Rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Allow reading all movies and votes
    match /movies/{document=**} {
      allow read: if true;
      allow write: if false;
    }
    
    match /votes/{document=**} {
      allow read: if true;
      allow create: if true;
      allow update, delete: if false;
    }
  }
}
```

## Setup Instructions

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your `reelconvo` project
3. Create collections:
   - Click "Create collection" → name it `movies`
   - Click "Create collection" → name it `votes`
4. Add your first movie documents to the `movies` collection
5. Set `active: true` for movies you want in current voting

## How It Works

1. **Loading**: App fetches all documents from `movies` collection where `active == true`
2. **Display**: Shows movies sorted by `vote_count` with vote percentage bars
3. **Voting**: When user submits, the app:
   - Increments the `vote_count` field in the movie document
   - Creates a new document in `votes` collection for analytics
4. **Refresh**: After voting, votes list updates automatically
