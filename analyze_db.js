import { db } from './database.js';

function analyzeDatabase() {
    const entries = db.getAllEntries();
    const stats = db.getStats();
    
    // Sort entries by timestamp (newest first)
    const sortedEntries = [...entries].sort((a, b) => 
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    console.log('=== Database Analysis ===\n');
    console.log('Summary:');
    console.log(`Total unique packages: ${stats.totalPackages}`);
    console.log(`Total phantom dependencies: ${stats.totalPhantomDeps}`);
    console.log(`Average phantom deps per package: ${stats.averagePhantomDepsPerPackage.toFixed(2)}\n`);

    console.log('Most Common Phantom Dependencies:');
    Object.entries(stats.mostCommonPhantomDeps)
        .slice(0, 10)
        .forEach(([dep, count], idx) => {
            console.log(`${idx + 1}. ${dep}: ${count} packages`);
        });

    console.log('\nNewest Entries (last 5):');
    sortedEntries.slice(0, 5).forEach((entry, idx) => {
        console.log(`\n#${idx + 1}: ${entry.packageName}`);
        console.log('Phantom deps:', entry.phantomDeps.join(', '));
        console.log('Download count:', entry.downloadCount || 'Not recorded');
        console.log('Added:', new Date(entry.timestamp).toLocaleString());
    });

    // Analyze dependency patterns
    const depPatterns = new Map();
    entries.forEach(entry => {
        entry.phantomDeps.forEach(dep => {
            if (!depPatterns.has(dep)) {
                depPatterns.set(dep, new Set());
            }
            depPatterns.get(dep).add(entry.packageName);
        });
    });

    console.log('\nInteresting Patterns:');
    
    // Find packages that commonly appear together
    const commonPairs = new Map();
    entries.forEach(entry => {
        for (let i = 0; i < entry.phantomDeps.length; i++) {
            for (let j = i + 1; j < entry.phantomDeps.length; j++) {
                const pair = [entry.phantomDeps[i], entry.phantomDeps[j]].sort().join(' + ');
                commonPairs.set(pair, (commonPairs.get(pair) || 0) + 1);
            }
        }
    });

    console.log('\nCommon Dependency Pairs:');
    Array.from(commonPairs.entries())
        .filter(([, count]) => count > 1)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .forEach(([pair, count]) => {
            console.log(`${pair}: appears in ${count} packages`);
        });
}

analyzeDatabase();