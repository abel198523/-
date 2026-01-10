const { BINGO_CARDS } = require('./data/cards');

function verifyCards() {
    const cardStrings = new Map();
    const cards = Object.entries(BINGO_CARDS);
    
    console.log("Total cards: " + cards.length);
    
    let duplicates = 0;
    cards.forEach(([id, card]) => {
        const cardStr = JSON.stringify(card);
        if (cardStrings.has(cardStr)) {
            console.log("Duplicate found: Card " + id + " is identical to Card " + cardStrings.get(cardStr));
            duplicates++;
        }
        cardStrings.set(cardStr, id);
        
        const flat = card.flat();
        const zeros = flat.filter(n => n === 0).length;
        if (zeros !== 1) {
            console.log("Card " + id + " has " + zeros + " zeros instead of 1");
        }
        
        const uniqueNums = new Set(flat);
        if (uniqueNums.size !== 25) {
             console.log("Card " + id + " has only " + uniqueNums.size + " unique numbers (including 0)");
        }
    });
    
    if (duplicates === 0) {
        console.log("All cards are unique and valid!");
    } else {
        console.log("Found " + duplicates + " duplicates.");
    }
}

verifyCards();
